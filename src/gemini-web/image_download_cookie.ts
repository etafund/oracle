import {
  assertConstrainedUrl,
  UrlConstraintError,
  type UrlConstraint,
} from "../browser/url_constraint.js";

const GEMINI_GENERATED_IMAGE_DOWNLOAD_CONSTRAINT = {
  label: "Gemini generated image download",
  allowedSchemes: ["https"],
  allowedHosts: ["lh3.googleusercontent.com"],
  allowedPathPrefixes: ["/gg-dl/"],
} as const satisfies UrlConstraint;

const GEMINI_GENERATED_IMAGE_REDIRECT_CONSTRAINTS = [
  GEMINI_GENERATED_IMAGE_DOWNLOAD_CONSTRAINT,
  {
    label: "Gemini generated image redirect",
    allowedSchemes: ["https"],
    allowedHosts: ["work.fife.usercontent.google.com"],
    allowedPathPrefixes: ["/rd-gg-dl/"],
  },
] as const satisfies readonly UrlConstraint[];

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_IMAGE_DOWNLOAD_REDIRECTS = 10;

export interface DownloadGeminiImageWithCookiesOptions {
  readonly url: string | URL;
  readonly cookieHeader: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

export interface DownloadGeminiImageWithCookiesResult {
  readonly response: Response;
  readonly finalUrl: string;
}

export function assertTrustedGeminiImageDownloadUrl(rawUrl: string | URL): URL {
  return assertConstrainedUrl(rawUrl, GEMINI_GENERATED_IMAGE_DOWNLOAD_CONSTRAINT);
}

export function isTrustedGeminiImageDownloadUrl(rawUrl: string | URL): boolean {
  try {
    assertTrustedGeminiImageDownloadUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export async function downloadGeminiImageWithCookies(
  options: DownloadGeminiImageWithCookiesOptions,
): Promise<DownloadGeminiImageWithCookiesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let currentUrl = assertTrustedGeminiImageDownloadUrl(options.url);

  for (let redirectCount = 0; redirectCount <= MAX_IMAGE_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        cookie: options.cookieHeader,
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
      },
      redirect: "manual",
      signal: options.signal,
    });

    if (!isRedirectResponse(response)) {
      return { response, finalUrl: currentUrl.toString() };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new UrlConstraintError(
        "Gemini generated image redirect did not include a Location header.",
        "redirect_missing_location",
      );
    }
    currentUrl = assertTrustedGeminiImageRedirectUrl(new URL(location, currentUrl));
  }

  throw new UrlConstraintError(
    "Gemini generated image download exceeded the redirect limit.",
    "redirect_limit_exceeded",
  );
}

function assertTrustedGeminiImageRedirectUrl(rawUrl: string | URL): URL {
  const failures: UrlConstraintError[] = [];
  for (const constraint of GEMINI_GENERATED_IMAGE_REDIRECT_CONSTRAINTS) {
    try {
      return assertConstrainedUrl(rawUrl, constraint);
    } catch (error) {
      if (error instanceof UrlConstraintError) {
        failures.push(error);
      }
    }
  }

  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  const firstFailure = failures[0];
  throw new UrlConstraintError(
    firstFailure?.message ??
      `Gemini generated image redirect URL host "${url.hostname}" is not trusted.`,
    firstFailure?.code ?? "untrusted_host",
  );
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}
