import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { extractVideoId } from '@/lib/utils';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { ensureMergedFormat } from '@/lib/transcript-format-detector';
import { TranscriptSegment } from '@/lib/types';
import { dependencyUnavailable, unavailableResponse } from '@/lib/dependency-unavailable';

async function handler(req: NextRequest) {
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    // Extract video ID from URL
    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Get current user if logged in (optional)
    const { data: { user } } = await supabase.auth.getUser();

    // Check for cached video
    const { data: cachedVideo, error: cacheError } = await supabase
      .from('video_analyses')
      .select('*')
      .eq('youtube_id', videoId)
      .maybeSingle();

    if (cacheError) throw dependencyUnavailable('video-cache', cacheError);

    if (cachedVideo) {
      let ownedByCurrentUser = false;

      if (user?.id) {
        // Check if user is the original creator via created_by column
        if (cachedVideo.created_by && cachedVideo.created_by === user.id) {
          ownedByCurrentUser = true;
        } else {
          const ownershipQuery = supabase
            .from('video_generations')
            .select('id')
            .eq('user_id', user.id)
            .limit(1);

          const orConditions: string[] = [];

          if (cachedVideo.id) {
            orConditions.push(`video_id.eq.${cachedVideo.id}`);
          }
          if (videoId) {
            orConditions.push(`youtube_id.eq.${videoId}`);
          }

          if (orConditions.length > 0) {
            ownershipQuery.or(orConditions.join(','));
          }

          const { data: generationLink, error: generationError } = await ownershipQuery.maybeSingle();

          if (generationError) {
            console.error('Failed to check video generations ownership:', generationError);
          }

          if (generationLink) {
            ownedByCurrentUser = true;
          }
        }
      }
      // If user is logged in, track their access to this video
      if (user) {
        await supabase
          .from('user_videos')
          .upsert({
            user_id: user.id,
            video_id: cachedVideo.id,
            accessed_at: new Date().toISOString()
          }, {
            onConflict: 'user_id,video_id'
          });
      }

      // Ensure transcript is in merged format (backward compatibility for old cached videos)
      const originalTranscript = cachedVideo.transcript as TranscriptSegment[];
      const migratedTranscript = ensureMergedFormat(originalTranscript, {
        enableLogging: true,
        context: `YouTube ID: ${videoId}`
      });

      // Return all cached data including transcript and video info
      return NextResponse.json({
        status: 'found',
        cached: true,
        videoId: videoId,
        // Include the database UUID so the client can pass it directly to
        // notes/save endpoints, avoiding a youtube_id lookup that can fail.
        videoDbId: cachedVideo.id,
        topics: cachedVideo.topics,
        transcript: migratedTranscript,
        videoInfo: {
          title: cachedVideo.title,
          author: cachedVideo.author,
          duration: cachedVideo.duration,
          thumbnail: cachedVideo.thumbnail_url,
          language: cachedVideo.language ?? undefined,
          availableLanguages: cachedVideo.available_languages ?? undefined
        },
        summary: cachedVideo.summary,
        suggestedQuestions: cachedVideo.suggested_questions,
        cacheDate: cachedVideo.created_at,
        ownedByCurrentUser
      });
    }

    // Video not cached
    return NextResponse.json({
      status: 'absent',
      cached: false,
      videoId: videoId
    });

  } catch (error) {
    dependencyUnavailable('video-cache', error);
    const response = unavailableResponse();
    return new NextResponse(response.body, { status: 503, headers: response.headers });
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.PUBLIC);
