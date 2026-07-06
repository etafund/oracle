export interface GeminiWebOptions {
  youtube?: string;
  generateImage?: string;
  editImage?: string;
  outputPath?: string;
  showThoughts?: boolean;
  aspectRatio?: string;
  /**
   * Deep Think fallback policy. `"fail"` means the run must throw instead of
   * silently continuing on the HTTP/header path when the DOM Deep Think
   * flow can't be engaged (e.g. attachments or image generation force an
   * HTTP fallback). Unset preserves the historical silently-degraded
   * behavior (log only, continue on HTTP).
   */
  deepThinkFallback?: "fail";
}

export interface GeminiWebResponse {
  text: string | null;
  thoughts: string | null;
  has_images: boolean;
  image_count: number;
  /**
   * Model that actually produced this answer. Differs from the requested
   * model when the HTTP path retried with FALLBACK_GEMINI_WEB_MODEL after a
   * model-unavailable error (errorCode 1052); callers must surface that
   * substitution instead of silently returning a weaker model's answer.
   */
  effective_model?: string | null;
  error?: string;
}
