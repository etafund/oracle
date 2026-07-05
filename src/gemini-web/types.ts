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
  error?: string;
}
