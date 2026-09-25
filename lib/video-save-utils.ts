import { SupabaseClient } from '@supabase/supabase-js';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';

interface VideoAnalysisParams {
  youtubeId: string;
  title: string;
  author: string | null;
  duration: number;
  thumbnailUrl: string | null;
  transcript: unknown;
  topics: unknown;
  summary?: unknown;
  suggestedQuestions?: unknown;
  modelUsed?: string | null;
  userId?: string | null;
  language?: string | null;
  availableLanguages?: unknown;
}

interface SaveResult {
  success: boolean;
  videoId: string | null;
  error: string | null;
  retriedCount: number;
}

interface RetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Saves video analysis with retry logic for transient failures.
 *
 * The main failure mode is FK constraint violations when the user's profile
 * hasn't been fully created yet (race condition on new signups). This function
 * retries with exponential backoff to handle such cases.
 */
export async function saveVideoAnalysisWithRetry(
  supabase: SupabaseClient,
  params: VideoAnalysisParams,
  options?: RetryOptions
): Promise<SaveResult> {
  const { maxRetries = 3, retryDelayMs = 500 } = options ?? {};

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.rpc('insert_video_analysis_server', {
        p_youtube_id: params.youtubeId,
        p_title: params.title,
        p_author: params.author,
        p_duration: params.duration,
        p_thumbnail_url: params.thumbnailUrl,
        p_transcript: params.transcript,
        p_topics: params.topics,
        p_summary: params.summary ?? null,
        p_suggested_questions: params.suggestedQuestions ?? null,
        p_model_used: params.modelUsed ?? null,
        p_user_id: params.userId ?? null,
        p_language: params.language ?? null,
        p_available_languages: params.availableLanguages ?? null
      });

      if (error) throw error;
      if (typeof data !== 'string' || !data) throw new Error('Missing saved analysis ID');

      return {
        success: true,
        videoId: data as string,
        error: null,
        retriedCount: attempt
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if this is a retryable error (FK constraint, profile not ready)
      const isRetryableError =
        errorMessage.includes('foreign key') ||
        errorMessage.includes('profiles') ||
        errorMessage.includes('violates foreign key constraint') ||
        errorMessage.includes('user_videos_user_id_fkey');

      if (isRetryableError && attempt < maxRetries - 1) {
        console.warn(
          `[saveVideoAnalysis] Attempt ${attempt + 1}/${maxRetries} failed with retryable error, ` +
          `retrying in ${retryDelayMs * (attempt + 1)}ms`
        );
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }

      dependencyUnavailable('analysis-save', err);
      return { success: false, videoId: null, error: 'PERSISTENCE_UNAVAILABLE', retriedCount: attempt };
    }
  }

  return {
    success: false,
    videoId: null,
    error: 'Max retries exceeded',
    retriedCount: maxRetries
  };
}

/**
 * Ensures a user_videos link exists for a given user and video.
 * This is a fallback mechanism for when the initial save fails but the video exists.
 */
export async function ensureUserVideoLink(
  supabase: SupabaseClient,
  userId: string,
  youtubeId: string
): Promise<{ linked: boolean; videoId: string | null; error: string | null }> {
  try {
    // First, check if the video exists
    const { data: video, error: videoError } = await supabase
      .from('video_analyses')
      .select('id')
      .eq('youtube_id', youtubeId)
      .single();

    if (videoError || !video) {
      return { linked: false, videoId: null, error: 'Video not found' };
    }

    // Check if link already exists
    const { data: existingLink } = await supabase
      .from('user_videos')
      .select('id')
      .eq('user_id', userId)
      .eq('video_id', video.id)
      .single();

    if (existingLink) {
      return { linked: true, videoId: video.id, error: null };
    }

    // Create the missing link
    const { error: insertError } = await supabase
      .from('user_videos')
      .upsert(
        {
          user_id: userId,
          video_id: video.id,
          accessed_at: new Date().toISOString()
        },
        { onConflict: 'user_id,video_id' }
      );

    if (insertError) {
      console.error('[ensureUserVideoLink] Failed to create link:', insertError);
      return { linked: false, videoId: video.id, error: insertError.message };
    }

    return { linked: true, videoId: video.id, error: null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[ensureUserVideoLink] Unexpected error:', err);
    return { linked: false, videoId: null, error: errorMessage };
  }
}
