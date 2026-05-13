import { assertConstrainedUrl, UrlConstraintError } from "../url_constraint.js";

const CHATGPT_IMAGE_DOWNLOAD_CONSTRAINT = {
  label: "ChatGPT image download",
  allowedSchemes: ["https"],
  allowedHosts: ["chatgpt.com", "chat.openai.com"],
  allowedPaths: ["/backend-api/estuary/content"],
  requiredSearchParam: { name: "id", prefix: "file_" },
} as const;

const MAX_IMAGE_DOWNLOAD_REDIRECTS = 5;

export function assertTrustedChatGptImageDownloadUrl(rawUrl: string | URL): URL {
  return assertConstrainedUrl(rawUrl, CHATGPT_IMAGE_DOWNLOAD_CONSTRAINT);
}

export function isTrustedChatGptImageDownloadUrl(rawUrl: string | URL): boolean {
  try {
    assertTrustedChatGptImageDownloadUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export interface DownloadChatGptImageWithCookiesOptions {
  readonly url: string | URL;
  readonly cookieHeader: string;
  readonly fetchImpl?: typeof fetch;
}

export interface DownloadChatGptImageWithCookiesResult {
  readonly response: Response;
  readonly finalUrl: string;
}

export async function downloadChatGptImageWithCookies(
  options: DownloadChatGptImageWithCookiesOptions,
): Promise<DownloadChatGptImageWithCookiesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let currentUrl = assertTrustedChatGptImageDownloadUrl(options.url);

  for (let redirectCount = 0; redirectCount <= MAX_IMAGE_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        cookie: options.cookieHeader,
        "user-agent": "Mozilla/5.0",
      },
      redirect: "manual",
    });

    if (!isRedirectResponse(response)) {
      return { response, finalUrl: currentUrl.toString() };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new UrlConstraintError(
        "ChatGPT image download redirect did not include a Location header.",
        "redirect_missing_location",
      );
    }
    currentUrl = assertTrustedChatGptImageDownloadUrl(new URL(location, currentUrl));
  }

  throw new UrlConstraintError(
    "ChatGPT image download exceeded the redirect limit.",
    "redirect_limit_exceeded",
  );
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}
