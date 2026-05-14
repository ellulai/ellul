from django.http import HttpResponse, JsonResponse
from django.urls import path

INDEX_HTML = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{PROJECT_NAME}}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }
    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }
  </style>
</head>
<body>
  <main style="display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%">
    <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5">ellul</div>
    <div>
      <h1 style="font-size:2.8rem;font-weight:600;letter-spacing:-0.02em">Your app is ready.</h1>
      <p style="font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem">Ask the agent to build, or edit this page to start shipping.</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem">
      <div style="border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85">
        <div style="font-weight:500;margin-bottom:0.25rem">Edit</div>
        <div style="opacity:0.6;font-size:0.75rem">Change this file, see it live.</div>
      </div>
      <div style="border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85">
        <div style="font-weight:500;margin-bottom:0.25rem">Chat</div>
        <div style="opacity:0.6;font-size:0.75rem">Ask the agent to build features.</div>
      </div>
    </div>
  </main>
</body>
</html>"""


def index(_request):
    return HttpResponse(INDEX_HTML, content_type="text/html")


def health(_request):
    return JsonResponse({"ok": True})


urlpatterns = [
    path("", index),
    path("api/health", health),
]
