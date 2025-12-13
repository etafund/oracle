#!/usr/bin/env python3

import sys
import asyncio
import json
import os
import re
from pathlib import Path

try:
    from gemini_webapi import set_log_level
    set_log_level("ERROR")
except ImportError:
    pass

def print_help():
    help_text = """Usage: webapi [OPTIONS] PROMPT

All-purpose Gemini 3 Pro client with Thinking enabled.
Uses browser cookies for authentication - no API key required.

Arguments:
  PROMPT                Text prompt for query/generation

Options:
  --file, -f FILE       Input file (repeatable; MP4, PDF, PNG, JPG, etc.)
  --youtube URL         YouTube video URL to analyze
  --generate-image FILE Generate image and save to FILE
  --edit IMAGE          Edit existing image (use with --output)
  --output, -o FILE     Output file path (for image generation/editing)
  --aspect RATIO        Aspect ratio for image generation (16:9, 1:1, 4:3, 3:4)
  --show-thoughts       Display model's thinking process
  --model MODEL         Model to use (default: gemini-3.0-pro)
  --json                Output response as JSON
  --help, -h            Show this help message

Examples:
  # Text query
  webapi "Explain quantum computing"

  # Analyze local video
  webapi "Summarize this video" --file video.mp4

  # Analyze YouTube video
  webapi "What are the key points?" --youtube "https://youtube.com/watch?v=..."

  # Analyze document
  webapi "Summarize this report" --file report.pdf

  # Generate image
  webapi "A sunset over mountains" --generate-image sunset.png

  # Edit image
  webapi "Make the sky purple" --edit photo.jpg --output edited.png

  # Show thinking process
  webapi "Solve this step by step: What is 15% of 240?" --show-thoughts

Model: gemini-3.0-pro (Thinking with 3 Pro)

Prerequisites:
  1. Log into gemini.google.com in Chrome
  2. pip install -r requirements.txt (or use the venv)
  3. First run on macOS will prompt for Keychain access"""
    print(help_text)

def parse_args(args):
    result = {
        "prompt": None,
        "files": [],
        "youtube": None,
        "generate_image": None,
        "edit": None,
        "output": None,
        "aspect": None,
        "show_thoughts": False,
        "model": "gemini-3.0-pro",
        "json_output": False,
    }

    i = 0
    positional = []

    while i < len(args):
        arg = args[i]

        if arg in ("--help", "-h"):
            print_help()
            sys.exit(0)
        elif arg in ("--file", "-f"):
            i += 1
            if i >= len(args):
                print("Error: --file requires a path", file=sys.stderr)
                sys.exit(1)
            result["files"].append(args[i])
        elif arg == "--youtube":
            i += 1
            if i >= len(args):
                print("Error: --youtube requires a URL", file=sys.stderr)
                sys.exit(1)
            result["youtube"] = args[i]
        elif arg == "--generate-image":
            i += 1
            if i >= len(args):
                print("Error: --generate-image requires an output filename", file=sys.stderr)
                sys.exit(1)
            result["generate_image"] = args[i]
        elif arg == "--edit":
            i += 1
            if i >= len(args):
                print("Error: --edit requires an input image", file=sys.stderr)
                sys.exit(1)
            result["edit"] = args[i]
        elif arg in ("--output", "-o"):
            i += 1
            if i >= len(args):
                print("Error: --output requires a filename", file=sys.stderr)
                sys.exit(1)
            result["output"] = args[i]
        elif arg == "--aspect":
            i += 1
            if i >= len(args):
                print("Error: --aspect requires a ratio", file=sys.stderr)
                sys.exit(1)
            result["aspect"] = args[i]
        elif arg == "--show-thoughts":
            result["show_thoughts"] = True
        elif arg == "--model":
            i += 1
            if i >= len(args):
                print("Error: --model requires a model name", file=sys.stderr)
                sys.exit(1)
            result["model"] = args[i]
        elif arg == "--json":
            result["json_output"] = True
        elif not arg.startswith("-"):
            positional.append(arg)
        else:
            print(f"Error: Unknown option {arg}", file=sys.stderr)
            sys.exit(1)

        i += 1

    if not positional:
        print("Error: PROMPT is required", file=sys.stderr)
        print("Use --help for usage information", file=sys.stderr)
        sys.exit(1)

    result["prompt"] = " ".join(positional)
    return result

async def run(args):
    try:
        from gemini_webapi import GeminiClient
        from gemini_webapi.types import GeneratedImage
        from gemini_webapi.utils import rotate_1psidts
        from gemini_webapi.constants import Endpoint, Headers
        from gemini_webapi.exceptions import ModelInvalid
        from httpx import AsyncClient
    except ImportError:
        print("Error: gemini-webapi not installed", file=sys.stderr)
        print("Run: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)

    prompt = args["prompt"]
    files = []

    if args["aspect"] and (args["generate_image"] or args["edit"]):
        prompt = f"{prompt} (aspect ratio: {args['aspect']})"

    for raw_file in args["files"]:
        file_path = Path(raw_file)
        if not file_path.exists():
            print(f"Error: File not found: {raw_file}", file=sys.stderr)
            sys.exit(1)
        files.append(str(file_path.resolve()))

    edit_image_path = None
    if args["edit"]:
        edit_path = Path(args["edit"])
        if not edit_path.exists():
            print(f"Error: Image not found: {args['edit']}", file=sys.stderr)
            sys.exit(1)
        edit_image_path = str(edit_path.resolve())

    if args["youtube"]:
        prompt = f"{prompt}\n\nYouTube video: {args['youtube']}"

    if args["generate_image"] and not args["edit"]:
        prompt = f"Generate an image: {prompt}"

    model = args["model"]

    print(f"Initializing Gemini client...", file=sys.stderr)

    cookie_map = {}
    cookies_json = os.environ.get("ORACLE_GEMINI_COOKIES_JSON")
    if cookies_json:
        try:
            parsed = json.loads(cookies_json)
            if isinstance(parsed, dict):
                cookie_map = {str(k): str(v) for k, v in parsed.items() if v is not None}
        except Exception:
            # Ignore malformed cookie input; we'll fall back to gemini-webapi's browser cookie loader.
            cookie_map = {}

    # Backwards-compatible env keys (used by earlier Oracle versions).
    secure_1psid = cookie_map.get("__Secure-1PSID") or os.environ.get("ORACLE_GEMINI_SECURE_1PSID")
    secure_1psidts = cookie_map.get("__Secure-1PSIDTS") or os.environ.get("ORACLE_GEMINI_SECURE_1PSIDTS")

    try:
        if secure_1psid:
            client = GeminiClient(secure_1psid=secure_1psid, secure_1psidts=secure_1psidts)
            if cookie_map:
                client.cookies.update(cookie_map)
        else:
            client = GeminiClient()

        async def compat_init(
            timeout: float = 120,
            auto_close: bool = False,
            close_delay: float = 300,
            auto_refresh: bool = True,
            refresh_interval: float = 540,
            verbose: bool = False,
        ) -> None:
            if secure_1psid and secure_1psidts:
                # Some accounts require a freshly rotated __Secure-1PSIDTS value for initialization.
                try:
                    new_1psidts = await rotate_1psidts(
                        {"__Secure-1PSID": secure_1psid, "__Secure-1PSIDTS": secure_1psidts, **client.cookies}
                    )
                    if new_1psidts:
                        client.cookies["__Secure-1PSIDTS"] = new_1psidts
                except Exception:
                    pass

            async with AsyncClient(proxy=client.proxy, follow_redirects=True, verify=False) as bootstrap_client:
                google_response = await bootstrap_client.get(Endpoint.GOOGLE.value)
                extra_cookies = {k: v for k, v in google_response.cookies.items()}

                merged_cookies = {**extra_cookies, **client.cookies}
                init_response = await bootstrap_client.get(
                    Endpoint.INIT.value, headers=Headers.GEMINI.value, cookies=merged_cookies
                )
                init_html = init_response.text

            token = None
            for key in ["SNlM0e", "thykhd"]:
                match = re.search(rf'"{key}":"(.*?)"', init_html)
                if match:
                    token = match.group(1)
                    break

            if not token:
                raise RuntimeError("Failed to locate Gemini access token on the app page.")

            if getattr(client, "client", None) is not None:
                try:
                    await client.client.aclose()
                except Exception:
                    pass

            client.client = AsyncClient(
                timeout=timeout,
                proxy=client.proxy,
                follow_redirects=True,
                headers=Headers.GEMINI.value,
                cookies=merged_cookies,
                verify=False,
            )
            client.access_token = token
            client.cookies = merged_cookies
            client._running = True

            client.timeout = timeout
            client.auto_close = auto_close
            client.close_delay = close_delay
            client.auto_refresh = auto_refresh
            client.refresh_interval = refresh_interval

        # Override gemini-webapi's init so any future re-initialization attempts (triggered by retries/close())
        # go through the compatibility path instead of relying on legacy token extraction.
        client.init = compat_init
        await client.init(timeout=120, auto_close=False, auto_refresh=True, verbose=False)
    except Exception as e:
        print(f"Error initializing client: {e}", file=sys.stderr)
        print("Make sure you're logged into gemini.google.com in Chrome", file=sys.stderr)
        sys.exit(1)

    print(f"Querying {model}...", file=sys.stderr)

    try:
        captured_generate_response = {"text": None}

        async def capture_generate_response(response):
            try:
                url = str(getattr(getattr(response, "request", None), "url", ""))
            except Exception:
                url = ""
            if "StreamGenerate" in url:
                try:
                    captured_generate_response["text"] = response.text
                except Exception:
                    captured_generate_response["text"] = None

        if getattr(client, "client", None) is not None:
            hooks = getattr(client.client, "event_hooks", None)
            if isinstance(hooks, dict):
                hooks.setdefault("response", []).append(capture_generate_response)

        async def execute_request(model_to_use: str):
            if edit_image_path:
                chat = client.start_chat(model=model_to_use)
                await chat.send_message("Here is an image to edit", files=[edit_image_path])
                edit_prompt_local = f"Use image generation tool to {prompt}"
                return await chat.send_message(edit_prompt_local), edit_prompt_local
            if files:
                return await client.generate_content(prompt, files=files, model=model_to_use), None
            return await client.generate_content(prompt, model=model_to_use), None

        edit_prompt = None
        try:
            response, edit_prompt = await execute_request(model)
        except ModelInvalid:
            # Some accounts don't have access to the requested "Pro" models on gemini.google.com.
            fallback_model = "gemini-2.5-flash"
            if model != fallback_model:
                print(f"Model {model} is not available; retrying with {fallback_model}...", file=sys.stderr)
                model = fallback_model
                response, edit_prompt = await execute_request(model)
            else:
                raise
        except Exception as e:
            raw = captured_generate_response.get("text") or ""
            if "Invalid response data received" in str(e) and "af.httprm" in raw:
                print(
                    "Gemini returned an unexpected response for this request. This often happens when file/image features "
                    "aren't enabled for the current Gemini account/region (or the web endpoint changed).",
                    file=sys.stderr,
                )
            raise

        if args["generate_image"] or edit_image_path:
            output_path = Path(args["generate_image"] or args["output"] or "generated.png")
            output_dir = output_path.parent if output_path.parent != Path(".") else Path(".")

            saved_count = 0
            used_fallback_model = False

            def has_image_placeholder(text: str | None) -> bool:
                if not text:
                    return False
                return bool(re.search(r"http://googleusercontent\\.com/image_generation_content/\\d+", text))

            def extract_ggdl_urls(raw_text: str | None) -> list[str]:
                if not raw_text:
                    return []
                matches = re.findall(r"https://lh3\\.googleusercontent\\.com/gg-dl/[^\\s\"']+", raw_text)
                # Preserve order, de-dupe.
                seen = set()
                urls = []
                for match in matches:
                    if match in seen:
                        continue
                    seen.add(match)
                    urls.append(match)
                return urls

            if not response.images:
                # Gemini sometimes returns generated images but doesn't populate response.images.
                # Try to extract and download the underlying gg-dl image artifact from the raw StreamGenerate response.
                ggdl_urls = extract_ggdl_urls(captured_generate_response.get("text"))
                if ggdl_urls:
                    try:
                        image = GeneratedImage(url=ggdl_urls[0], cookies=client.cookies, proxy=client.proxy)
                        await image.save(path=str(output_dir), filename=output_path.name)
                        saved_count = len(ggdl_urls)
                    except Exception as e:
                        print(f"Failed to download Gemini-generated image (will retry with fallback models): {e}", file=sys.stderr)
                        saved_count = 0

            if saved_count == 0:
                if (not response.images) and has_image_placeholder(response.text):
                    # Some models return a placeholder URL but no parsed image payload. Fall back to known-good image models.
                    fallback_models = ["gemini-2.5-flash", "gemini-2.5-pro"]
                    for fallback_model in fallback_models:
                        if fallback_model == model:
                            continue
                        print(f"Retrying image generation with {fallback_model}...", file=sys.stderr)
                        model = fallback_model
                        used_fallback_model = True
                        if edit_image_path:
                            chat = client.start_chat(model=model)
                            await chat.send_message("Here is an image to edit", files=[edit_image_path])
                            response = await chat.send_message(edit_prompt or f"Use image generation tool to {prompt}")
                        elif files:
                            response = await client.generate_content(prompt, files=files, model=model)
                        else:
                            response = await client.generate_content(prompt, model=model)
                        if response.images:
                            break

                if not response.images:
                    print("No images generated. Response text:", file=sys.stderr)
                    if response.text:
                        print(response.text)
                    else:
                        print("(empty response)")
                    sys.exit(1)

                image = response.images[0]
                await image.save(path=str(output_dir), filename=output_path.name)
                saved_count = len(response.images)

            if saved_count > 1:
                print(f"({saved_count} images generated, saved first one)", file=sys.stderr)
            if used_fallback_model:
                print(f"(Used fallback image model: {model})", file=sys.stderr)

            if args["json_output"]:
                output = {
                    "text": f"Saved: {output_path}",
                    "thoughts": None,
                    "has_images": saved_count > 0,
                    "image_count": saved_count,
                }
                print(json.dumps(output, indent=2))
            else:
                print(f"Saved: {output_path}")
                if response.text:
                    print(f"\nResponse: {response.text}")
        else:
            if args["json_output"]:
                output = {
                    "text": response.text,
                    "thoughts": response.thoughts if args["show_thoughts"] else None,
                    "has_images": bool(response.images),
                    "image_count": len(response.images) if response.images else 0,
                }
                print(json.dumps(output, indent=2))
            else:
                if args["show_thoughts"] and response.thoughts:
                    print("=== Thinking ===")
                    print(response.thoughts)
                    print("\n=== Response ===")

                if response.text:
                    print(response.text)
                else:
                    print("(empty response)")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.close()

def main():
    args = parse_args(sys.argv[1:])
    asyncio.run(run(args))

if __name__ == "__main__":
    main()
