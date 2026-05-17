// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/* eslint-disable */
// ╔══════════════════════════════════════════════════════════════════╗
// ║ GENERATED FILE — DO NOT EDIT BY HAND                            ║
// ║ Source:  src/templates/scaffold/trees/                          ║
// ║ Rebuild: pnpm -w -F @ellul.ai/vps run build:scaffold-manifest   ║
// ╚══════════════════════════════════════════════════════════════════╝

export interface TreeEntry {
  kind: 'text' | 'binary';
  /** Text: utf-8 source. Binary: base64-encoded bytes. */
  content: string;
  /** POSIX file mode (e.g. 0o755). Omitted = default (0o644). */
  mode?: number;
}

export type TreeManifest = Record<string, Record<string, TreeEntry>>;

export const TREE_MANIFEST: TreeManifest = {
  "astro": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules/\ndist/\n.astro/\n.env*\n!.env.example\n.DS_Store\n"
    },
    "astro.config.mjs": {
      "kind": "text",
      "content": "import { defineConfig } from 'astro/config';\nimport tailwindcss from '@tailwindcss/vite';\n\nexport default defineConfig({\n  server: {\n    host: '0.0.0.0',\n  },\n  vite: {\n    plugins: [tailwindcss()],\n    server: {\n      allowedHosts: ['.{{APP_ZONE}}', 'localhost'],\n    },\n  },\n});\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"type\": \"module\",\n  \"version\": \"0.0.1\",\n  \"scripts\": {\n    \"dev\": \"astro dev\",\n    \"start\": \"astro dev\",\n    \"build\": \"astro check && astro build\",\n    \"preview\": \"astro preview\",\n    \"astro\": \"astro\"\n  },\n  \"dependencies\": {\n    \"astro\": \"^5.0.0\"\n  },\n  \"devDependencies\": {\n    \"@tailwindcss/vite\": \"^4\",\n    \"tailwindcss\": \"^4\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/pages/index.astro": {
      "kind": "text",
      "content": "---\nimport '../styles/global.css';\n---\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width\" />\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <main class=\"min-h-screen flex items-center justify-center px-6 py-12\">\n      <div class=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n        <div class=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n        <div>\n          <h1 class=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n          <p class=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n        </div>\n        <div class=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n          <div class=\"rounded-lg border border-current/10 p-4\">\n            <div class=\"font-medium mb-1\">Edit</div>\n            <div class=\"opacity-60 text-xs\">Change this file, see it live.</div>\n          </div>\n          <div class=\"rounded-lg border border-current/10 p-4\">\n            <div class=\"font-medium mb-1\">Chat</div>\n            <div class=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n          </div>\n        </div>\n      </div>\n    </main>\n  </body>\n</html>\n"
    },
    "src/styles/global.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n}\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"extends\": \"astro/tsconfigs/strict\",\n  \"include\": [\".astro/types.d.ts\", \"**/*\"],\n  \"exclude\": [\"dist\"]\n}\n"
    }
  },
  "blank": {
    "README.md": {
      "kind": "text",
      "content": "# {{PROJECT_NAME}}\n\nA blank workspace. Build whatever you want — the AI agent already has full platform context via CLAUDE.md at the sandbox root.\n"
    }
  },
  "bun": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\ndist\nbun.lockb\n.env*\n!.env.example\n.DS_Store\n*.log\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"bun --hot src/index.ts\",\n    \"start\": \"bun src/index.ts\"\n  },\n  \"devDependencies\": {\n    \"@types/bun\": \"^1.1.0\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/index.ts": {
      "kind": "text",
      "content": "const port = Number(process.env.PORT) || 3000;\n\nBun.serve({\n  port,\n  hostname: '0.0.0.0',\n  fetch(req) {\n    const url = new URL(req.url);\n    if (url.pathname === '/api/health') {\n      return Response.json({ ok: true });\n    }\n    return Response.json({ message: 'Your app is ready.', powered: 'ellul' });\n  },\n});\n\nconsole.log(`Listening on http://0.0.0.0:${port}`);\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"types\": [\"bun-types\"],\n    \"esModuleInterop\": true,\n    \"strict\": true,\n    \"skipLibCheck\": true,\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"noEmit\": true,\n    \"lib\": [\"ES2022\"]\n  },\n  \"include\": [\"src/**/*\"]\n}\n"
    }
  },
  "dart": {
    ".gitignore": {
      "kind": "text",
      "content": ".dart_tool/\n.packages\npubspec.lock\n.env*\n!.env.example\n"
    },
    "bin/app.dart": {
      "kind": "text",
      "content": "void main() {\n  print('Your app is ready. Powered by ellul');\n}\n"
    },
    "pubspec.yaml": {
      "kind": "text",
      "content": "name: app\ndescription: {{PROJECT_NAME}}\nversion: 0.1.0\nenvironment:\n  sdk: \">=3.0.0 <4.0.0\"\n"
    }
  },
  "django": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n.venv/\nvenv/\nenv/\n.env*\n!.env.example\ndb.sqlite3\nstaticfiles/\n"
    },
    "config/__init__.py": {
      "kind": "text",
      "content": ""
    },
    "config/asgi.py": {
      "kind": "text",
      "content": "import os\nfrom django.core.asgi import get_asgi_application\n\nos.environ.setdefault(\"DJANGO_SETTINGS_MODULE\", \"config.settings\")\napplication = get_asgi_application()\n"
    },
    "config/settings.py": {
      "kind": "text",
      "content": "\"\"\"Minimal Django settings for {{PROJECT_NAME}}.\"\"\"\nfrom pathlib import Path\n\nBASE_DIR = Path(__file__).resolve().parent.parent\n\nSECRET_KEY = \"insecure-scaffold-key-replace-before-deploy\"\nDEBUG = True\nALLOWED_HOSTS = [\"*\"]\n\nINSTALLED_APPS = [\n    \"django.contrib.auth\",\n    \"django.contrib.contenttypes\",\n    \"django.contrib.staticfiles\",\n]\n\nMIDDLEWARE: list[str] = []\nROOT_URLCONF = \"config.urls\"\nTEMPLATES: list[dict] = []\nWSGI_APPLICATION = \"config.wsgi.application\"\nSTATIC_URL = \"static/\"\nDEFAULT_AUTO_FIELD = \"django.db.models.BigAutoField\"\n"
    },
    "config/urls.py": {
      "kind": "text",
      "content": "from django.http import HttpResponse, JsonResponse\nfrom django.urls import path\n\nINDEX_HTML = \"\"\"<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\"\"\"\n\n\ndef index(_request):\n    return HttpResponse(INDEX_HTML, content_type=\"text/html\")\n\n\ndef health(_request):\n    return JsonResponse({\"ok\": True})\n\n\nurlpatterns = [\n    path(\"\", index),\n    path(\"api/health\", health),\n]\n"
    },
    "config/wsgi.py": {
      "kind": "text",
      "content": "import os\nfrom django.core.wsgi import get_wsgi_application\n\nos.environ.setdefault(\"DJANGO_SETTINGS_MODULE\", \"config.settings\")\napplication = get_wsgi_application()\n"
    },
    "manage.py": {
      "kind": "text",
      "content": "#!/usr/bin/env python\n\"\"\"Django's command-line utility for administrative tasks.\"\"\"\nimport os\nimport sys\n\n\ndef main() -> None:\n    os.environ.setdefault(\"DJANGO_SETTINGS_MODULE\", \"config.settings\")\n    try:\n        from django.core.management import execute_from_command_line\n    except ImportError as exc:\n        raise ImportError(\n            \"Couldn't import Django. Are you sure it's installed?\"\n        ) from exc\n    execute_from_command_line(sys.argv)\n\n\nif __name__ == \"__main__\":\n    main()\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": "django\ngunicorn\n"
    }
  },
  "dotnet": {
    ".gitignore": {
      "kind": "text",
      "content": "bin/\nobj/\n*.user\n*.suo\npublish/\n.vs/\n.env*\n!.env.example\n"
    },
    "app.csproj": {
      "kind": "text",
      "content": "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>App</RootNamespace>\n  </PropertyGroup>\n</Project>\n"
    },
    "appsettings.json": {
      "kind": "text",
      "content": "{\n  \"Logging\": {\n    \"LogLevel\": { \"Default\": \"Information\", \"Microsoft.AspNetCore\": \"Warning\" }\n  },\n  \"AllowedHosts\": \"*\"\n}\n"
    },
    "Program.cs": {
      "kind": "text",
      "content": "var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\n\napp.MapGet(\"/\", () => Results.Content(\"\"\"\n<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\n\"\"\", \"text/html\"));\n\napp.MapGet(\"/api/health\", () => new { ok = true });\n\napp.Run();\n"
    }
  },
  "elixir": {
    ".gitignore": {
      "kind": "text",
      "content": "/_build/\n/cover/\n/deps/\n/doc/\n/.fetch\nerl_crash.dump\n*.ez\n*.beam\n.env*\n!.env.example\n"
    },
    "lib/app.ex": {
      "kind": "text",
      "content": "defmodule App do\n  @moduledoc \"\"\"\n  {{PROJECT_NAME}} — edit this file to start building.\n  \"\"\"\n\n  def hello, do: \"Your app is ready. Powered by ellul\"\nend\n"
    },
    "mix.exs": {
      "kind": "text",
      "content": "defmodule App.MixProject do\n  use Mix.Project\n\n  def project do\n    [\n      app: :app,\n      version: \"0.1.0\",\n      elixir: \"~> 1.15\",\n      start_permanent: Mix.env() == :prod,\n      deps: deps()\n    ]\n  end\n\n  def application do\n    [extra_applications: [:logger]]\n  end\n\n  defp deps do\n    []\n  end\nend\n"
    }
  },
  "express": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\ndist\n.env*\n!.env.example\n.DS_Store\n*.log\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"tsx watch src/index.ts\",\n    \"start\": \"tsx src/index.ts\"\n  },\n  \"dependencies\": {\n    \"express\": \"^4.21.0\"\n  },\n  \"devDependencies\": {\n    \"@types/express\": \"^4.17.21\",\n    \"@types/node\": \"^22.10.0\",\n    \"tsx\": \"^4.19.0\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/index.ts": {
      "kind": "text",
      "content": "import express from 'express';\n\nconst app = express();\n\napp.get('/', (_req, res) => {\n  res.json({ message: 'Your app is ready.', powered: 'ellul' });\n});\n\napp.get('/api/health', (_req, res) => {\n  res.json({ ok: true });\n});\n\nconst port = Number(process.env.PORT) || 3000;\napp.listen(port, '0.0.0.0', () => {\n  console.log(`Listening on http://0.0.0.0:${port}`);\n});\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"esModuleInterop\": true,\n    \"strict\": true,\n    \"skipLibCheck\": true,\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"noEmit\": true,\n    \"lib\": [\"ES2022\"]\n  },\n  \"include\": [\"src/**/*\"]\n}\n"
    }
  },
  "fastapi": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n.venv/\nvenv/\nenv/\n.env*\n!.env.example\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n"
    },
    "main.py": {
      "kind": "text",
      "content": "\"\"\"FastAPI app for {{PROJECT_NAME}} — edit this file to start building.\"\"\"\n\nfrom fastapi import FastAPI\nfrom fastapi.responses import HTMLResponse\n\napp = FastAPI(title=\"{{PROJECT_NAME}}\")\n\nINDEX_HTML = \"\"\"<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\"\"\"\n\n\n@app.get(\"/\", response_class=HTMLResponse)\ndef root():\n    return INDEX_HTML\n\n\n@app.get(\"/api/health\")\ndef health() -> dict:\n    return {\"ok\": True}\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": "fastapi\nuvicorn[standard]\n"
    }
  },
  "fastify": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\ndist\n.env*\n!.env.example\n.DS_Store\n*.log\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"tsx watch src/index.ts\",\n    \"start\": \"tsx src/index.ts\"\n  },\n  \"dependencies\": {\n    \"fastify\": \"^5.0.0\"\n  },\n  \"devDependencies\": {\n    \"@types/node\": \"^22.10.0\",\n    \"tsx\": \"^4.19.0\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/index.ts": {
      "kind": "text",
      "content": "import Fastify from 'fastify';\n\nconst app = Fastify({ logger: true });\n\napp.get('/', async () => ({ message: 'Your app is ready.', powered: 'ellul' }));\napp.get('/api/health', async () => ({ ok: true }));\n\nconst port = Number(process.env.PORT) || 3000;\napp.listen({ port, host: '0.0.0.0' }, (err, addr) => {\n  if (err) { app.log.error(err); process.exit(1); }\n  app.log.info(`Listening on ${addr}`);\n});\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"esModuleInterop\": true,\n    \"strict\": true,\n    \"skipLibCheck\": true,\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"noEmit\": true,\n    \"lib\": [\"ES2022\"]\n  },\n  \"include\": [\"src/**/*\"]\n}\n"
    }
  },
  "flask": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n.venv/\nvenv/\nenv/\ninstance/\n.env*\n!.env.example\n.pytest_cache/\n"
    },
    "app.py": {
      "kind": "text",
      "content": "\"\"\"Flask app for {{PROJECT_NAME}} — edit this file to start building.\"\"\"\n\nfrom flask import Flask, jsonify\n\napp = Flask(__name__)\n\nINDEX_HTML = \"\"\"<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\"\"\"\n\n\n@app.get(\"/\")\ndef root():\n    return INDEX_HTML, 200, {\"Content-Type\": \"text/html\"}\n\n\n@app.get(\"/api/health\")\ndef health():\n    return jsonify(ok=True)\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": "flask\n"
    }
  },
  "flutter": {
    ".gitignore": {
      "kind": "text",
      "content": ".dart_tool/\n.flutter-plugins\n.flutter-plugins-dependencies\n.packages\n.pub-cache/\n.pub/\nbuild/\npubspec.lock\n.env*\n!.env.example\n"
    },
    "lib/main.dart": {
      "kind": "text",
      "content": "import 'package:flutter/material.dart';\n\nvoid main() => runApp(const App());\n\nclass App extends StatelessWidget {\n  const App({super.key});\n\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp(\n      title: '{{PROJECT_NAME}}',\n      theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF171717)),\n      home: const Scaffold(\n        body: Center(\n          child: Column(\n            mainAxisAlignment: MainAxisAlignment.center,\n            children: [\n              Text('ellul', style: TextStyle(letterSpacing: 4, fontSize: 12)),\n              SizedBox(height: 16),\n              Text('Your app is ready.', style: TextStyle(fontSize: 32, fontWeight: FontWeight.w600)),\n              SizedBox(height: 8),\n              Text(\n                'Ask the agent to build, or edit this page to start shipping.',\n                style: TextStyle(fontSize: 14),\n              ),\n            ],\n          ),\n        ),\n      ),\n    );\n  }\n}\n"
    },
    "pubspec.yaml": {
      "kind": "text",
      "content": "name: app\ndescription: {{PROJECT_NAME}}\npublish_to: 'none'\nversion: 0.1.0\n\nenvironment:\n  sdk: \">=3.3.0 <4.0.0\"\n\ndependencies:\n  flutter:\n    sdk: flutter\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n\nflutter:\n  uses-material-design: true\n"
    },
    "web/index.html": {
      "kind": "text",
      "content": "<!DOCTYPE html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <script src=\"main.dart.js\"></script>\n  </body>\n</html>\n"
    }
  },
  "golang": {
    ".gitignore": {
      "kind": "text",
      "content": "/app\n/bin/\n/tmp/\n*.test\n*.out\nvendor/\n.env*\n!.env.example\n"
    },
    "go.mod": {
      "kind": "text",
      "content": "module {{PROJECT_NAME}}\n\ngo 1.21\n"
    },
    "main.go": {
      "kind": "text",
      "content": "package main\n\nimport (\n\t\"encoding/json\"\n\t\"fmt\"\n\t\"log\"\n\t\"net/http\"\n\t\"os\"\n)\n\nconst indexHTML = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>`\n\nfunc main() {\n\thttp.HandleFunc(\"/api/health\", func(w http.ResponseWriter, _ *http.Request) {\n\t\tw.Header().Set(\"Content-Type\", \"application/json\")\n\t\tjson.NewEncoder(w).Encode(map[string]bool{\"ok\": true})\n\t})\n\thttp.HandleFunc(\"/\", func(w http.ResponseWriter, _ *http.Request) {\n\t\tw.Header().Set(\"Content-Type\", \"text/html\")\n\t\tfmt.Fprint(w, indexHTML)\n\t})\n\n\tport := os.Getenv(\"PORT\")\n\tif port == \"\" {\n\t\tport = \"4000\"\n\t}\n\tlog.Printf(\"Listening on http://0.0.0.0:%s\", port)\n\tlog.Fatal(http.ListenAndServe(fmt.Sprintf(\":%s\", port), nil))\n}\n"
    }
  },
  "gradio": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n.venv/\nvenv/\nflagged/\n.env*\n!.env.example\n"
    },
    "app.py": {
      "kind": "text",
      "content": "\"\"\"Gradio app for {{PROJECT_NAME}} — edit this file to start building.\"\"\"\nimport os\n\nimport gradio as gr\n\n\ndef greet(name: str) -> str:\n    return f\"Hello, {name or 'world'}! — ellul\"\n\n\ndemo = gr.Interface(fn=greet, inputs=\"text\", outputs=\"text\", title=\"{{PROJECT_NAME}}\")\n\nif __name__ == \"__main__\":\n    demo.launch(\n        server_name=\"0.0.0.0\",\n        server_port=int(os.environ.get(\"PORT\", 7860)),\n    )\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": "gradio\n"
    }
  },
  "hono": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\ndist\n.env*\n!.env.example\n.DS_Store\n*.log\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"tsx watch src/index.ts\",\n    \"start\": \"tsx src/index.ts\"\n  },\n  \"dependencies\": {\n    \"@hono/node-server\": \"^1.13.0\",\n    \"hono\": \"^4.6.0\"\n  },\n  \"devDependencies\": {\n    \"@types/node\": \"^22.10.0\",\n    \"tsx\": \"^4.19.0\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/index.ts": {
      "kind": "text",
      "content": "import { Hono } from 'hono';\nimport { serve } from '@hono/node-server';\n\nconst app = new Hono();\n\napp.get('/', (c) => c.json({ message: 'Your app is ready.', powered: 'ellul' }));\napp.get('/api/health', (c) => c.json({ ok: true }));\n\nconst port = Number(process.env.PORT) || 3000;\nserve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {\n  console.log(`Listening on http://0.0.0.0:${info.port}`);\n});\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"esModuleInterop\": true,\n    \"strict\": true,\n    \"skipLibCheck\": true,\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"noEmit\": true,\n    \"lib\": [\"ES2022\"]\n  },\n  \"include\": [\"src/**/*\"]\n}\n"
    }
  },
  "java-gradle": {
    ".gitignore": {
      "kind": "text",
      "content": "build/\n.gradle/\n.idea/\n*.iml\nbin/\n.env*\n!.env.example\n"
    },
    "build.gradle": {
      "kind": "text",
      "content": "plugins {\n    id 'application'\n}\n\ngroup = 'com.example'\nversion = '0.1.0'\n\njava {\n    sourceCompatibility = '17'\n}\n\napplication {\n    mainClass = 'com.example.app.App'\n}\n\nrepositories {\n    mavenCentral()\n}\n"
    },
    "settings.gradle": {
      "kind": "text",
      "content": "rootProject.name = '{{PROJECT_NAME}}'\n"
    },
    "src/main/java/com/example/app/App.java": {
      "kind": "text",
      "content": "package com.example.app;\n\npublic class App {\n    public static void main(String[] args) {\n        System.out.println(\"Your app is ready. Powered by ellul\");\n    }\n}\n"
    }
  },
  "java-maven": {
    ".gitignore": {
      "kind": "text",
      "content": "target/\n.idea/\n*.iml\n.classpath\n.project\n.settings/\n.env*\n!.env.example\n"
    },
    "pom.xml": {
      "kind": "text",
      "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>app</artifactId>\n  <version>0.1.0</version>\n  <name>{{PROJECT_NAME}}</name>\n\n  <properties>\n    <maven.compiler.source>17</maven.compiler.source>\n    <maven.compiler.target>17</maven.compiler.target>\n    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n  </properties>\n</project>\n"
    },
    "src/main/java/com/example/app/App.java": {
      "kind": "text",
      "content": "package com.example.app;\n\npublic class App {\n    public static void main(String[] args) {\n        System.out.println(\"Your app is ready. Powered by ellul\");\n    }\n}\n"
    }
  },
  "laravel": {
    ".gitignore": {
      "kind": "text",
      "content": "/vendor/\n/node_modules/\ncomposer.lock\n.env*\n!.env.example\n*.log\n/storage/*\n/bootstrap/cache/\n"
    },
    "artisan": {
      "kind": "text",
      "content": "#!/usr/bin/env php\n<?php\n// Placeholder artisan — full artisan becomes available after\n// `composer install` pulls Laravel. This stub keeps\n// `php artisan serve` operational by delegating to PHP's built-in\n// server when Laravel isn't yet resolved.\n$cmd = $argv[1] ?? \"\";\nif ($cmd === \"serve\") {\n  $host = \"0.0.0.0\";\n  $port = getenv(\"PORT\") ?: 8000;\n  passthru(\"php -S $host:$port -t public\");\n  exit;\n}\nfwrite(STDERR, \"Run `composer install` to enable full artisan commands.\\n\");\nexit(1);\n",
      "mode": 493
    },
    "composer.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"app/{{PROJECT_NAME}}\",\n  \"type\": \"project\",\n  \"require\": {\n    \"php\": \"^8.2\",\n    \"laravel/framework\": \"^11.0\"\n  },\n  \"scripts\": {\n    \"dev\": \"php artisan serve --host 0.0.0.0\"\n  }\n}\n"
    },
    "public/index.php": {
      "kind": "text",
      "content": "<?php\n// {{PROJECT_NAME}} — Laravel dev entrypoint.\n// `php artisan serve` routes via this file; edit routes/web.php to add endpoints.\n\n$path = parse_url($_SERVER[\"REQUEST_URI\"] ?? \"/\", PHP_URL_PATH);\n\nif ($path === \"/api/health\") {\n  header(\"Content-Type: application/json\");\n  echo json_encode([\"ok\" => true]);\n  exit;\n}\n\n?><!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\n"
    },
    "routes/web.php": {
      "kind": "text",
      "content": "<?php\n// Placeholder routes file. Full Laravel routing activates after\n// `composer install && php artisan serve`.\n"
    }
  },
  "nestjs": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\ndist\n.env*\n!.env.example\n.DS_Store\n*.log\n"
    },
    "nest-cli.json": {
      "kind": "text",
      "content": "{\n  \"$schema\": \"https://json.schemastore.org/nest-cli\",\n  \"collection\": \"@nestjs/schematics\",\n  \"sourceRoot\": \"src\"\n}\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"scripts\": {\n    \"build\": \"nest build\",\n    \"start\": \"nest start\",\n    \"dev\": \"nest start --watch\"\n  },\n  \"dependencies\": {\n    \"@nestjs/common\": \"^10.4.0\",\n    \"@nestjs/core\": \"^10.4.0\",\n    \"@nestjs/platform-express\": \"^10.4.0\",\n    \"reflect-metadata\": \"^0.2.2\",\n    \"rxjs\": \"^7.8.1\"\n  },\n  \"devDependencies\": {\n    \"@nestjs/cli\": \"^10.4.0\",\n    \"@types/node\": \"^22.10.0\",\n    \"typescript\": \"^5.6.0\"\n  }\n}\n"
    },
    "src/app.controller.ts": {
      "kind": "text",
      "content": "import { Controller, Get } from '@nestjs/common';\n\n@Controller()\nexport class AppController {\n  @Get()\n  getHello() {\n    return { message: 'Your app is ready.', powered: 'ellul' };\n  }\n\n  @Get('/api/health')\n  health() {\n    return { ok: true };\n  }\n}\n"
    },
    "src/app.module.ts": {
      "kind": "text",
      "content": "import { Module } from '@nestjs/common';\nimport { AppController } from './app.controller';\n\n@Module({\n  controllers: [AppController],\n})\nexport class AppModule {}\n"
    },
    "src/main.ts": {
      "kind": "text",
      "content": "import 'reflect-metadata';\nimport { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  const port = Number(process.env.PORT) || 3000;\n  await app.listen(port, '0.0.0.0');\n  console.log(`Listening on http://0.0.0.0:${port}`);\n}\nbootstrap();\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"module\": \"commonjs\",\n    \"declaration\": true,\n    \"removeComments\": true,\n    \"emitDecoratorMetadata\": true,\n    \"experimentalDecorators\": true,\n    \"allowSyntheticDefaultImports\": true,\n    \"target\": \"ES2022\",\n    \"sourceMap\": true,\n    \"outDir\": \"./dist\",\n    \"baseUrl\": \"./\",\n    \"incremental\": true,\n    \"skipLibCheck\": true,\n    \"strictNullChecks\": true,\n    \"strict\": true,\n    \"forceConsistentCasingInFileNames\": true\n  }\n}\n"
    }
  },
  "next": {
    ".gitignore": {
      "kind": "text",
      "content": "# dependencies\n/node_modules\n/.pnp\n.pnp.*\n.yarn/*\n!.yarn/patches\n!.yarn/plugins\n!.yarn/releases\n!.yarn/versions\n\n# testing\n/coverage\n\n# next.js\n/.next/\n/out/\n\n# production\n/build\n\n# misc\n.DS_Store\n*.pem\n\n# debug\nnpm-debug.log*\nyarn-debug.log*\nyarn-error.log*\n.pnpm-debug.log*\n\n# env files\n.env*\n!.env.example\n\n# vercel\n.vercel\n\n# typescript\n*.tsbuildinfo\nnext-env.d.ts\n"
    },
    "app/globals.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n}\n"
    },
    "app/layout.tsx": {
      "kind": "text",
      "content": "import type { Metadata } from 'next';\nimport './globals.css';\n\nexport const metadata: Metadata = {\n  title: '{{PROJECT_NAME}}',\n  description: 'Built on ellul',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n"
    },
    "app/page.tsx": {
      "kind": "text",
      "content": "export default function Page() {\n  return (\n    <main className=\"min-h-screen flex items-center justify-center px-6 py-12\">\n      <div className=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n        <div className=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n        <div>\n          <h1 className=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n          <p className=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n        </div>\n        <div className=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Edit</div>\n            <div className=\"opacity-60 text-xs\">Change this file, see it live.</div>\n          </div>\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Chat</div>\n            <div className=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n          </div>\n        </div>\n      </div>\n    </main>\n  );\n}\n"
    },
    "next-env.d.ts": {
      "kind": "text",
      "content": "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript\n"
    },
    "next.config.ts": {
      "kind": "text",
      "content": "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {\n  // Permit the {{APP_ZONE}} preview domain to serve dev bundles — Next's\n  // dev-origin check otherwise blocks requests whose Host header isn't\n  // localhost. The same list is used by our Caddy dev-route generator.\n  allowedDevOrigins: ['*.{{APP_ZONE}}'],\n};\n\nexport default nextConfig;\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"scripts\": {\n    \"dev\": \"next dev\",\n    \"build\": \"next build\",\n    \"start\": \"next start\",\n    \"lint\": \"next lint\"\n  },\n  \"dependencies\": {\n    \"next\": \"^15.0.0\",\n    \"react\": \"^19.0.0\",\n    \"react-dom\": \"^19.0.0\"\n  },\n  \"devDependencies\": {\n    \"@tailwindcss/postcss\": \"^4\",\n    \"@types/node\": \"^22\",\n    \"@types/react\": \"^19\",\n    \"@types/react-dom\": \"^19\",\n    \"tailwindcss\": \"^4\",\n    \"typescript\": \"^5\"\n  }\n}\n"
    },
    "postcss.config.mjs": {
      "kind": "text",
      "content": "export default {\n  plugins: {\n    '@tailwindcss/postcss': {},\n  },\n};\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"lib\": [\"dom\", \"dom.iterable\", \"esnext\"],\n    \"allowJs\": true,\n    \"skipLibCheck\": true,\n    \"strict\": true,\n    \"noEmit\": true,\n    \"esModuleInterop\": true,\n    \"module\": \"esnext\",\n    \"moduleResolution\": \"bundler\",\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"jsx\": \"preserve\",\n    \"incremental\": true,\n    \"plugins\": [{ \"name\": \"next\" }],\n    \"paths\": { \"@/*\": [\"./*\"] }\n  },\n  \"include\": [\"next-env.d.ts\", \"**/*.ts\", \"**/*.tsx\", \".next/types/**/*.ts\"],\n  \"exclude\": [\"node_modules\"]\n}\n"
    }
  },
  "nuxt": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\n.nuxt\n.output\n.DS_Store\n*.log\n.env*\n!.env.example\n.nitro\n.cache\ndist\n"
    },
    "app/app.vue": {
      "kind": "text",
      "content": "<template>\n  <main class=\"min-h-screen flex items-center justify-center px-6 py-12\">\n    <div class=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n      <div class=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n      <div>\n        <h1 class=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n        <p class=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n      </div>\n      <div class=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n        <div class=\"rounded-lg border border-current/10 p-4\">\n          <div class=\"font-medium mb-1\">Edit</div>\n          <div class=\"opacity-60 text-xs\">Change this file, see it live.</div>\n        </div>\n        <div class=\"rounded-lg border border-current/10 p-4\">\n          <div class=\"font-medium mb-1\">Chat</div>\n          <div class=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n        </div>\n      </div>\n    </div>\n  </main>\n</template>\n"
    },
    "app/assets/css/main.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n}\n"
    },
    "nuxt.config.ts": {
      "kind": "text",
      "content": "// https://nuxt.com/docs/api/configuration/nuxt-config\nimport tailwindcss from '@tailwindcss/vite';\n\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-04-01',\n  // `future.compatibilityVersion: 4` tells Nuxt 3 to use the v4\n  // directory layout (`srcDir = app/`). Our tree places `app.vue`\n  // under `app/` — without this flag Nuxt falls back to\n  // `srcDir = rootDir` and silently serves the built-in NuxtWelcome.\n  future: {\n    compatibilityVersion: 4,\n  },\n  devtools: { enabled: true },\n  css: ['~/assets/css/main.css'],\n  vite: {\n    plugins: [tailwindcss()],\n    // Vite 5.1+ blocks unknown Host headers — allow our preview\n    // domain. See CVE-2024-28849.\n    server: {\n      allowedHosts: ['.{{APP_ZONE}}', 'localhost'],\n    },\n  },\n});\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"build\": \"nuxt build\",\n    \"dev\": \"nuxt dev\",\n    \"generate\": \"nuxt generate\",\n    \"preview\": \"nuxt preview\",\n    \"postinstall\": \"nuxt prepare\"\n  },\n  \"dependencies\": {\n    \"nuxt\": \"^3.21.2\",\n    \"vue\": \"latest\"\n  },\n  \"devDependencies\": {\n    \"@tailwindcss/vite\": \"^4\",\n    \"tailwindcss\": \"^4\"\n  }\n}\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"extends\": \"./.nuxt/tsconfig.json\"\n}\n"
    }
  },
  "phoenix": {
    ".gitignore": {
      "kind": "text",
      "content": "/_build/\n/deps/\n*.ez\nerl_crash.dump\n.env*\n!.env.example\n"
    },
    "config/config.exs": {
      "kind": "text",
      "content": "import Config\n\nconfig :app, port: String.to_integer(System.get_env(\"PORT\") || \"4000\")\n"
    },
    "lib/app/application.ex": {
      "kind": "text",
      "content": "defmodule App.Application do\n  use Application\n\n  def start(_type, _args) do\n    port = String.to_integer(System.get_env(\"PORT\") || \"4000\")\n\n    children = [\n      {Plug.Cowboy, scheme: :http, plug: AppWeb.Router, options: [port: port, ip: {0, 0, 0, 0}]}\n    ]\n\n    Supervisor.start_link(children, strategy: :one_for_one, name: App.Supervisor)\n  end\nend\n"
    },
    "lib/app_web/controllers/page_controller.ex": {
      "kind": "text",
      "content": "defmodule AppWeb.PageController do\n  def index_html do\n    \"\"\"\n    <!DOCTYPE html>\n    <html>\n    <head>\n      <meta charset=\"utf-8\">\n      <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n      <title>{{PROJECT_NAME}}</title>\n      <style>\n        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n        body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n        @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n      </style>\n    </head>\n    <body>\n      <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n        <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n        <div>\n          <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n          <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n        </div>\n        <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n          <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n            <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n            <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n          </div>\n          <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n            <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n            <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n          </div>\n        </div>\n      </main>\n    </body>\n    </html>\n    \"\"\"\n  end\nend\n"
    },
    "lib/app_web/router.ex": {
      "kind": "text",
      "content": "defmodule AppWeb.Router do\n  use Plug.Router\n\n  plug :match\n  plug :dispatch\n\n  get \"/\" do\n    send_resp(conn, 200, AppWeb.PageController.index_html())\n  end\n\n  get \"/api/health\" do\n    conn\n    |> put_resp_content_type(\"application/json\")\n    |> send_resp(200, Jason.encode!(%{ok: true}))\n  end\n\n  match _ do\n    send_resp(conn, 404, \"Not found\")\n  end\nend\n"
    },
    "mix.exs": {
      "kind": "text",
      "content": "defmodule App.MixProject do\n  use Mix.Project\n\n  def project do\n    [\n      app: :app,\n      version: \"0.1.0\",\n      elixir: \"~> 1.14\",\n      deps: deps()\n    ]\n  end\n\n  def application do\n    [mod: {App.Application, []}, extra_applications: [:logger]]\n  end\n\n  defp deps do\n    [\n      {:plug_cowboy, \"~> 2.6.0\"},\n      {:jason, \"~> 1.2\"}\n    ]\n  end\nend\n"
    }
  },
  "php": {
    ".gitignore": {
      "kind": "text",
      "content": "/vendor/\ncomposer.lock\n.env*\n!.env.example\n*.log\n"
    },
    "composer.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"app/{{PROJECT_NAME}}\",\n  \"type\": \"project\",\n  \"require\": {\n    \"php\": \"^8.2\"\n  }\n}\n"
    },
    "index.php": {
      "kind": "text",
      "content": "<?php\n$path = parse_url($_SERVER[\"REQUEST_URI\"] ?? \"/\", PHP_URL_PATH);\n\nif ($path === \"/api/health\") {\n  header(\"Content-Type: application/json\");\n  echo json_encode([\"ok\" => true]);\n  exit;\n}\n\n?><!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n    <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n    <div>\n      <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n      <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n      </div>\n      <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n        <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n        <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </main>\n</body>\n</html>\n"
    }
  },
  "python": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n*.pyo\n*.pyd\n.Python\n.venv/\nvenv/\nenv/\n.env*\n!.env.example\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n*.egg-info/\ndist/\nbuild/\n"
    },
    "app.py": {
      "kind": "text",
      "content": "\"\"\"Entrypoint for {{PROJECT_NAME}} — edit this file to start building.\"\"\"\n\n\ndef main() -> None:\n    print(\"Your app is ready. Powered by ellul\")\n\n\nif __name__ == \"__main__\":\n    main()\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": ""
    }
  },
  "rails": {
    ".gitignore": {
      "kind": "text",
      "content": ".bundle/\nvendor/bundle/\ntmp/\nlog/\n*.log\n.env*\n!.env.example\nstorage/\ndb/*.sqlite3\ndb/*.sqlite3-*\n"
    },
    "app/controllers/application_controller.rb": {
      "kind": "text",
      "content": "class ApplicationController < ActionController::Base\n  def index\n  end\n\n  def health\n    render json: { ok: true }\n  end\nend\n"
    },
    "app/views/application/index.html.erb": {
      "kind": "text",
      "content": "<main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n  <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n  <div>\n    <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n    <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n  </div>\n  <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n    <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n      <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n      <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n    </div>\n    <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n      <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n      <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n    </div>\n  </div>\n</main>\n"
    },
    "app/views/layouts/application.html.erb": {
      "kind": "text",
      "content": "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title><%= content_for?(:title) ? yield(:title) : \"{{PROJECT_NAME}}\" %></title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n    @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n  </style>\n</head>\n<body>\n  <%= yield %>\n</body>\n</html>\n"
    },
    "bin/rails": {
      "kind": "text",
      "content": "#!/usr/bin/env ruby\nAPP_PATH = File.expand_path(\"../config/application\", __dir__)\nrequire_relative \"../config/boot\"\nrequire \"rails/commands\"\n",
      "mode": 493
    },
    "bin/rake": {
      "kind": "text",
      "content": "#!/usr/bin/env ruby\nrequire_relative \"../config/boot\"\nrequire \"rake\"\nRake.application.run\n",
      "mode": 493
    },
    "config/application.rb": {
      "kind": "text",
      "content": "require_relative \"boot\"\nrequire \"rails\"\nrequire \"action_controller/railtie\"\nrequire \"action_view/railtie\"\n\nmodule App\n  class Application < Rails::Application\n    config.load_defaults 7.1\n    config.hosts.clear\n  end\nend\n"
    },
    "config/boot.rb": {
      "kind": "text",
      "content": "ENV[\"BUNDLE_GEMFILE\"] ||= File.expand_path(\"../Gemfile\", __dir__)\nrequire \"bundler/setup\"\nrequire \"bootsnap/setup\"\n"
    },
    "config/environment.rb": {
      "kind": "text",
      "content": "require_relative \"application\"\nRails.application.initialize!\n"
    },
    "config/environments/development.rb": {
      "kind": "text",
      "content": "require \"active_support/core_ext/integer/time\"\n\nRails.application.configure do\n  config.enable_reloading = true\n  config.eager_load = false\n  config.consider_all_requests_local = true\n  config.server_timing = true\n  config.cache_classes = false\nend\n"
    },
    "config/environments/production.rb": {
      "kind": "text",
      "content": "require \"active_support/core_ext/integer/time\"\n\nRails.application.configure do\n  config.enable_reloading = false\n  config.eager_load = true\n  config.consider_all_requests_local = false\n  config.assume_ssl = true\n  config.log_level = ENV.fetch(\"RAILS_LOG_LEVEL\", \"info\")\nend\n"
    },
    "config/routes.rb": {
      "kind": "text",
      "content": "Rails.application.routes.draw do\n  root \"application#index\"\n  get \"/api/health\", to: \"application#health\"\nend\n"
    },
    "config.ru": {
      "kind": "text",
      "content": "require_relative \"config/environment\"\nrun Rails.application\nRails.application.load_server\n"
    },
    "Gemfile": {
      "kind": "text",
      "content": "source \"https://rubygems.org\"\n\nruby \">= 3.1\"\n\ngem \"rails\", \"~> 7.1\"\ngem \"puma\"\ngem \"bootsnap\", require: false\n"
    },
    "Rakefile": {
      "kind": "text",
      "content": "require_relative \"config/application\"\nRails.application.load_tasks\n"
    }
  },
  "remix": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\n/.cache\n/build\n.env*\n!.env.example\n.DS_Store\n"
    },
    "app/root.tsx": {
      "kind": "text",
      "content": "import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';\nimport type { LinksFunction } from '@remix-run/node';\nimport tailwindHref from './tailwind.css?url';\n\nexport const links: LinksFunction = () => [{ rel: 'stylesheet', href: tailwindHref }];\n\nexport default function App() {\n  return (\n    <html lang=\"en\">\n      <head>\n        <meta charSet=\"utf-8\" />\n        <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />\n        <Meta />\n        <Links />\n      </head>\n      <body>\n        <Outlet />\n        <ScrollRestoration />\n        <Scripts />\n      </body>\n    </html>\n  );\n}\n"
    },
    "app/routes/_index.tsx": {
      "kind": "text",
      "content": "export default function Index() {\n  return (\n    <main className=\"min-h-screen flex items-center justify-center px-6 py-12\">\n      <div className=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n        <div className=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n        <div>\n          <h1 className=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n          <p className=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n        </div>\n        <div className=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Edit</div>\n            <div className=\"opacity-60 text-xs\">Change this file, see it live.</div>\n          </div>\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Chat</div>\n            <div className=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n          </div>\n        </div>\n      </div>\n    </main>\n  );\n}\n"
    },
    "app/tailwind.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n}\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"sideEffects\": false,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"remix vite:dev\",\n    \"build\": \"remix vite:build\",\n    \"start\": \"remix-serve ./build/server/index.js\",\n    \"typecheck\": \"tsc\"\n  },\n  \"dependencies\": {\n    \"@remix-run/node\": \"^2.13.0\",\n    \"@remix-run/react\": \"^2.13.0\",\n    \"@remix-run/serve\": \"^2.13.0\",\n    \"isbot\": \"^5.1.17\",\n    \"react\": \"^18.3.0\",\n    \"react-dom\": \"^18.3.0\"\n  },\n  \"devDependencies\": {\n    \"@remix-run/dev\": \"^2.13.0\",\n    \"@tailwindcss/vite\": \"^4\",\n    \"@types/react\": \"^18.3.0\",\n    \"@types/react-dom\": \"^18.3.0\",\n    \"tailwindcss\": \"^4\",\n    \"typescript\": \"^5.6.0\",\n    \"vite\": \"^6.0.0\",\n    \"vite-tsconfig-paths\": \"^5.0.0\"\n  }\n}\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"include\": [\"**/*.ts\", \"**/*.tsx\", \"**/.server/**/*.ts\", \"**/.server/**/*.tsx\", \"**/.client/**/*.ts\", \"**/.client/**/*.tsx\"],\n  \"compilerOptions\": {\n    \"lib\": [\"DOM\", \"DOM.Iterable\", \"ES2022\"],\n    \"types\": [\"@remix-run/node\", \"vite/client\"],\n    \"isolatedModules\": true,\n    \"esModuleInterop\": true,\n    \"jsx\": \"react-jsx\",\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"Bundler\",\n    \"resolveJsonModule\": true,\n    \"target\": \"ES2022\",\n    \"strict\": true,\n    \"allowJs\": true,\n    \"skipLibCheck\": true,\n    \"forceConsistentCasingInFileNames\": true,\n    \"baseUrl\": \".\",\n    \"paths\": { \"~/*\": [\"./app/*\"] },\n    \"noEmit\": true\n  }\n}\n"
    },
    "vite.config.ts": {
      "kind": "text",
      "content": "import { vitePlugin as remix } from '@remix-run/dev';\nimport tailwindcss from '@tailwindcss/vite';\nimport { defineConfig } from 'vite';\nimport tsconfigPaths from 'vite-tsconfig-paths';\n\nexport default defineConfig({\n  plugins: [tailwindcss(), remix(), tsconfigPaths()],\n  server: {\n    host: '0.0.0.0',\n    allowedHosts: ['.{{APP_ZONE}}', 'localhost'],\n  },\n});\n"
    }
  },
  "ruby": {
    ".gitignore": {
      "kind": "text",
      "content": ".bundle/\nvendor/bundle/\ntmp/\nlog/\n*.log\n.env*\n!.env.example\n"
    },
    "config.ru": {
      "kind": "text",
      "content": "require \"json\"\n\nINDEX_HTML = <<~HTML\n  <!DOCTYPE html>\n  <html>\n  <head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <title>{{PROJECT_NAME}}</title>\n    <style>\n      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n      body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n      @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n    </style>\n  </head>\n  <body>\n    <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n      <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n      <div>\n        <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n        <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n      </div>\n      <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n        <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n          <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n          <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n        </div>\n        <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n          <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n          <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n        </div>\n      </div>\n    </main>\n  </body>\n  </html>\nHTML\n\nrun ->(env) {\n  if env[\"PATH_INFO\"] == \"/api/health\"\n    [200, { \"Content-Type\" => \"application/json\" }, [JSON.generate(ok: true)]]\n  else\n    [200, { \"Content-Type\" => \"text/html\" }, [INDEX_HTML]]\n  end\n}\n"
    },
    "Gemfile": {
      "kind": "text",
      "content": "source \"https://rubygems.org\"\n\nruby \">= 3.0\"\ngem \"rackup\"\ngem \"puma\"\n"
    }
  },
  "rust": {
    ".gitignore": {
      "kind": "text",
      "content": "/target/\nCargo.lock\n.env*\n!.env.example\n*.pdb\n"
    },
    "Cargo.toml": {
      "kind": "text",
      "content": "[package]\nname = \"{{PROJECT_NAME}}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n"
    },
    "src/main.rs": {
      "kind": "text",
      "content": "// {{PROJECT_NAME}} — edit this file to start building.\nfn main() {\n    println!(\"Your app is ready. Powered by ellul\");\n}\n"
    }
  },
  "sinatra": {
    ".gitignore": {
      "kind": "text",
      "content": ".bundle/\nvendor/bundle/\ntmp/\nlog/\n*.log\n.env*\n!.env.example\n"
    },
    "app.rb": {
      "kind": "text",
      "content": "require \"sinatra\"\nrequire \"json\"\n\nset :bind, \"0.0.0.0\"\nset :port, ENV.fetch(\"PORT\", 4567).to_i\n\nINDEX_HTML = <<~HTML\n  <!DOCTYPE html>\n  <html>\n  <head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <title>{{PROJECT_NAME}}</title>\n    <style>\n      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n      body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n      @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n    </style>\n  </head>\n  <body>\n    <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n      <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n      <div>\n        <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n        <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n      </div>\n      <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n        <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n          <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n          <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n        </div>\n        <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n          <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n          <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n        </div>\n      </div>\n    </main>\n  </body>\n  </html>\nHTML\n\nget \"/\" do\n  content_type :html\n  INDEX_HTML\nend\n\nget \"/api/health\" do\n  content_type :json\n  JSON.generate(ok: true)\nend\n"
    },
    "config.ru": {
      "kind": "text",
      "content": "require_relative \"app\"\nrun Sinatra::Application\n"
    },
    "Gemfile": {
      "kind": "text",
      "content": "source \"https://rubygems.org\"\n\nruby \">= 3.0\"\ngem \"sinatra\"\ngem \"puma\"\ngem \"rackup\"\n"
    }
  },
  "spring-boot": {
    ".gitignore": {
      "kind": "text",
      "content": "target/\n.idea/\n*.iml\n.classpath\n.project\n.settings/\n.vscode/\nHELP.md\n.env*\n!.env.example\n"
    },
    "pom.xml": {
      "kind": "text",
      "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n  <modelVersion>4.0.0</modelVersion>\n\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.3.0</version>\n    <relativePath/>\n  </parent>\n\n  <groupId>com.example</groupId>\n  <artifactId>app</artifactId>\n  <version>0.0.1-SNAPSHOT</version>\n  <name>{{PROJECT_NAME}}</name>\n\n  <properties>\n    <java.version>17</java.version>\n  </properties>\n\n  <dependencies>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-starter-web</artifactId>\n    </dependency>\n  </dependencies>\n\n  <build>\n    <plugins>\n      <plugin>\n        <groupId>org.springframework.boot</groupId>\n        <artifactId>spring-boot-maven-plugin</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>\n"
    },
    "src/main/java/com/example/app/AppApplication.java": {
      "kind": "text",
      "content": "package com.example.app;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.stereotype.Controller;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.ResponseBody;\n\nimport java.util.Map;\n\n@SpringBootApplication\n@Controller\npublic class AppApplication {\n    public static void main(String[] args) {\n        SpringApplication.run(AppApplication.class, args);\n    }\n\n    @GetMapping(value = \"/\", produces = \"text/html\")\n    @ResponseBody\n    public String root() {\n        return \"\"\"\n            <!DOCTYPE html>\n            <html>\n            <head>\n              <meta charset=\"utf-8\">\n              <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n              <title>{{PROJECT_NAME}}</title>\n              <style>\n                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n                body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n                @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n              </style>\n            </head>\n            <body>\n              <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n                <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n                <div>\n                  <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n                  <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n                </div>\n                <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n                  <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n                    <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n                    <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n                  </div>\n                  <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n                    <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n                    <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n                  </div>\n                </div>\n              </main>\n            </body>\n            </html>\n            \"\"\";\n    }\n\n    @GetMapping(\"/api/health\")\n    @ResponseBody\n    public Map<String, Boolean> health() {\n        return Map.of(\"ok\", true);\n    }\n}\n"
    },
    "src/main/resources/application.properties": {
      "kind": "text",
      "content": "server.port=${PORT:8080}\nserver.address=0.0.0.0\n"
    }
  },
  "spring-boot-gradle": {
    ".gitignore": {
      "kind": "text",
      "content": "build/\n.gradle/\n.idea/\n*.iml\nbin/\n.env*\n!.env.example\n"
    },
    "build.gradle": {
      "kind": "text",
      "content": "plugins {\n    id 'java'\n    id 'org.springframework.boot' version '3.3.0'\n    id 'io.spring.dependency-management' version '1.1.5'\n}\n\ngroup = 'com.example'\nversion = '0.0.1-SNAPSHOT'\n\njava {\n    sourceCompatibility = '17'\n}\n\nrepositories {\n    mavenCentral()\n}\n\ndependencies {\n    implementation 'org.springframework.boot:spring-boot-starter-web'\n}\n"
    },
    "settings.gradle": {
      "kind": "text",
      "content": "rootProject.name = '{{PROJECT_NAME}}'\n"
    },
    "src/main/java/com/example/app/AppApplication.java": {
      "kind": "text",
      "content": "package com.example.app;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.stereotype.Controller;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.ResponseBody;\n\nimport java.util.Map;\n\n@SpringBootApplication\n@Controller\npublic class AppApplication {\n    public static void main(String[] args) {\n        SpringApplication.run(AppApplication.class, args);\n    }\n\n    @GetMapping(value = \"/\", produces = \"text/html\")\n    @ResponseBody\n    public String root() {\n        return \"\"\"\n            <!DOCTYPE html>\n            <html>\n            <head>\n              <meta charset=\"utf-8\">\n              <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n              <title>{{PROJECT_NAME}}</title>\n              <style>\n                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n                body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; color: #111; background: #fff; }\n                @media (prefers-color-scheme: dark) { body { color: #f0f0f0; background: #111; } }\n              </style>\n            </head>\n            <body>\n              <main style=\"display:flex;flex-direction:column;align-items:center;gap:2rem;text-align:center;max-width:36rem;width:100%\">\n                <div style=\"font-size:0.7rem;text-transform:uppercase;letter-spacing:0.2em;opacity:0.5\">ellul</div>\n                <div>\n                  <h1 style=\"font-size:2.8rem;font-weight:600;letter-spacing:-0.02em\">Your app is ready.</h1>\n                  <p style=\"font-size:1rem;opacity:0.6;line-height:1.6;margin-top:0.5rem\">Ask the agent to build, or edit this page to start shipping.</p>\n                </div>\n                <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;width:100%;text-align:left;margin-top:1rem;font-size:0.875rem\">\n                  <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n                    <div style=\"font-weight:500;margin-bottom:0.25rem\">Edit</div>\n                    <div style=\"opacity:0.6;font-size:0.75rem\">Change this file, see it live.</div>\n                  </div>\n                  <div style=\"border-radius:0.5rem;border:1px solid currentColor;border-opacity:0.1;padding:1rem;opacity:0.85\">\n                    <div style=\"font-weight:500;margin-bottom:0.25rem\">Chat</div>\n                    <div style=\"opacity:0.6;font-size:0.75rem\">Ask the agent to build features.</div>\n                  </div>\n                </div>\n              </main>\n            </body>\n            </html>\n            \"\"\";\n    }\n\n    @GetMapping(\"/api/health\")\n    @ResponseBody\n    public Map<String, Boolean> health() {\n        return Map.of(\"ok\", true);\n    }\n}\n"
    },
    "src/main/resources/application.properties": {
      "kind": "text",
      "content": "server.port=${PORT:8080}\nserver.address=0.0.0.0\n"
    }
  },
  "streamlit": {
    ".gitignore": {
      "kind": "text",
      "content": "__pycache__/\n*.pyc\n.venv/\nvenv/\n.streamlit/secrets.toml\n.env*\n!.env.example\n"
    },
    "app.py": {
      "kind": "text",
      "content": "\"\"\"Streamlit app for {{PROJECT_NAME}} — edit this file to start building.\"\"\"\nimport streamlit as st\n\nst.set_page_config(page_title=\"{{PROJECT_NAME}}\", layout=\"centered\")\nst.markdown(\"### ellul\")\nst.title(\"Your app is ready.\")\nst.caption(\"Ask the agent to build, or edit this page to start shipping.\")\n"
    },
    "requirements.txt": {
      "kind": "text",
      "content": "streamlit\n"
    }
  },
  "svelte": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules\n/build\n/.svelte-kit\n/package\n.env*\n!.env.example\n.DS_Store\n.vercel\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"vite dev\",\n    \"build\": \"vite build\",\n    \"preview\": \"vite preview\",\n    \"prepare\": \"svelte-kit sync || echo ''\",\n    \"check\": \"svelte-kit sync && svelte-check --tsconfig ./tsconfig.json\"\n  },\n  \"devDependencies\": {\n    \"@sveltejs/adapter-auto\": \"^6.0.0\",\n    \"@sveltejs/kit\": \"^2.22.0\",\n    \"@sveltejs/vite-plugin-svelte\": \"^6.0.0\",\n    \"@tailwindcss/vite\": \"^4\",\n    \"svelte\": \"^5.0.0\",\n    \"svelte-check\": \"^4.0.0\",\n    \"tailwindcss\": \"^4\",\n    \"typescript\": \"^5.0.0\",\n    \"vite\": \"^6.0.0\"\n  }\n}\n"
    },
    "src/app.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n}\n"
    },
    "src/app.html": {
      "kind": "text",
      "content": "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <link rel=\"icon\" href=\"%sveltekit.assets%/favicon.png\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>{{PROJECT_NAME}}</title>\n    %sveltekit.head%\n  </head>\n  <body data-sveltekit-preload-data=\"hover\">\n    <div style=\"display: contents\">%sveltekit.body%</div>\n  </body>\n</html>\n"
    },
    "src/routes/+layout.svelte": {
      "kind": "text",
      "content": "<script>\n  import '../app.css';\n</script>\n\n<slot />\n"
    },
    "src/routes/+page.svelte": {
      "kind": "text",
      "content": "<main class=\"min-h-screen flex items-center justify-center px-6 py-12\">\n  <div class=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n    <div class=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n    <div>\n      <h1 class=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n      <p class=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n    </div>\n    <div class=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n      <div class=\"rounded-lg border border-current/10 p-4\">\n        <div class=\"font-medium mb-1\">Edit</div>\n        <div class=\"opacity-60 text-xs\">Change this file, see it live.</div>\n      </div>\n      <div class=\"rounded-lg border border-current/10 p-4\">\n        <div class=\"font-medium mb-1\">Chat</div>\n        <div class=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n      </div>\n    </div>\n  </div>\n</main>\n"
    },
    "svelte.config.js": {
      "kind": "text",
      "content": "import adapter from '@sveltejs/adapter-auto';\nimport { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\n\n/** @type {import('@sveltejs/kit').Config} */\nconst config = {\n  preprocess: vitePreprocess(),\n  kit: {\n    adapter: adapter(),\n  },\n};\n\nexport default config;\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"extends\": \"./.svelte-kit/tsconfig.json\",\n  \"compilerOptions\": {\n    \"allowJs\": true,\n    \"checkJs\": true,\n    \"esModuleInterop\": true,\n    \"forceConsistentCasingInFileNames\": true,\n    \"resolveJsonModule\": true,\n    \"skipLibCheck\": true,\n    \"sourceMap\": true,\n    \"strict\": true,\n    \"moduleResolution\": \"bundler\"\n  }\n}\n"
    },
    "vite.config.ts": {
      "kind": "text",
      "content": "import { sveltekit } from '@sveltejs/kit/vite';\nimport tailwindcss from '@tailwindcss/vite';\nimport { defineConfig } from 'vite';\n\n// Vite 5.1+ blocks unknown Host headers. Allow our preview domain.\nexport default defineConfig({\n  plugins: [tailwindcss(), sveltekit()],\n  server: {\n    host: '0.0.0.0',\n    allowedHosts: ['.{{APP_ZONE}}', 'localhost'],\n  },\n});\n"
    }
  },
  "turbo": {
    ".gitignore": {
      "kind": "text",
      "content": "node_modules/\n.turbo\n.DS_Store\n*.log\n.env*\n!.env.example\ndist/\nbuild/\n.next/\n"
    },
    "apps/.gitkeep": {
      "kind": "text",
      "content": ""
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"packageManager\": \"npm@10.0.0\",\n  \"workspaces\": [\"apps/*\", \"packages/*\"],\n  \"scripts\": {\n    \"dev\": \"turbo run dev\",\n    \"build\": \"turbo run build\",\n    \"lint\": \"turbo run lint\",\n    \"test\": \"turbo run test\"\n  },\n  \"devDependencies\": {\n    \"turbo\": \"^2.3.0\"\n  }\n}\n"
    },
    "packages/.gitkeep": {
      "kind": "text",
      "content": ""
    },
    "README.md": {
      "kind": "text",
      "content": "# {{PROJECT_NAME}}\n\nAn ellul Turborepo workspace.\n\n## Next steps\n\nAsk the agent to add an app or a shared package:\n\n- `Add a Next.js app named web`\n- `Add a Hono API named api`\n- `Add a shared types package`\n\nLeaves land under `apps/` (previewable) and `packages/` (shared code). The agent scaffolds each leaf using the same template system you scaffolded the monorepo with — no CLI invocations, fully deterministic.\n"
    },
    "turbo.json": {
      "kind": "text",
      "content": "{\n  \"$schema\": \"https://turbo.build/schema.json\",\n  \"tasks\": {\n    \"dev\": {\n      \"cache\": false,\n      \"persistent\": true\n    },\n    \"build\": {\n      \"dependsOn\": [\"^build\"],\n      \"outputs\": [\"dist/**\", \".next/**\", \"build/**\"]\n    },\n    \"lint\": {},\n    \"test\": {}\n  }\n}\n"
    }
  },
  "vite": {
    ".gitignore": {
      "kind": "text",
      "content": "# Logs\nlogs\n*.log\nnpm-debug.log*\n\nnode_modules\ndist\ndist-ssr\n*.local\n\n# Editor directories and files\n.vscode/*\n!.vscode/extensions.json\n.idea\n.DS_Store\n*.suo\n*.ntvs*\n*.njsproj\n*.sln\n*.sw?\n"
    },
    "index.html": {
      "kind": "text",
      "content": "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.tsx\"></script>\n  </body>\n</html>\n"
    },
    "package.json": {
      "kind": "text",
      "content": "{\n  \"name\": \"{{PROJECT_NAME}}\",\n  \"private\": true,\n  \"version\": \"0.0.0\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"tsc -b && vite build\",\n    \"preview\": \"vite preview\"\n  },\n  \"dependencies\": {\n    \"react\": \"^19.0.0\",\n    \"react-dom\": \"^19.0.0\"\n  },\n  \"devDependencies\": {\n    \"@tailwindcss/vite\": \"^4\",\n    \"@types/react\": \"^19.0.0\",\n    \"@types/react-dom\": \"^19.0.0\",\n    \"@vitejs/plugin-react\": \"^4.3.0\",\n    \"tailwindcss\": \"^4\",\n    \"typescript\": \"^5.6.0\",\n    \"vite\": \"^6.0.0\"\n  }\n}\n"
    },
    "src/App.tsx": {
      "kind": "text",
      "content": "export default function App() {\n  return (\n    <main className=\"min-h-screen flex items-center justify-center px-6 py-12\">\n      <div className=\"flex flex-col items-center gap-8 text-center max-w-xl w-full\">\n        <div className=\"text-xs uppercase tracking-[0.2em] opacity-50\">ellul</div>\n        <div>\n          <h1 className=\"text-5xl font-semibold tracking-tight\">Your app is ready.</h1>\n          <p className=\"text-base opacity-60 leading-relaxed\">Ask the agent to build, or edit this page to start shipping.</p>\n        </div>\n        <div className=\"grid grid-cols-2 gap-3 w-full text-sm text-left mt-4\">\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Edit</div>\n            <div className=\"opacity-60 text-xs\">Change this file, see it live.</div>\n          </div>\n          <div className=\"rounded-lg border border-current/10 p-4\">\n            <div className=\"font-medium mb-1\">Chat</div>\n            <div className=\"opacity-60 text-xs\">Ask the agent to build features.</div>\n          </div>\n        </div>\n      </div>\n    </main>\n  );\n}\n"
    },
    "src/index.css": {
      "kind": "text",
      "content": "@import \"tailwindcss\";\n\n:root {\n  --background: #ffffff;\n  --foreground: #171717;\n}\n\n@theme inline {\n  --color-background: var(--background);\n  --color-foreground: var(--foreground);\n  --font-sans: var(--font-geist-sans);\n  --font-mono: var(--font-geist-mono);\n}\n\nbody {\n  background: var(--background);\n  color: var(--foreground);\n  font-family: var(--font-sans), Arial, Helvetica, sans-serif;\n  margin: 0;\n}\n"
    },
    "src/main.tsx": {
      "kind": "text",
      "content": "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './index.css';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n"
    },
    "tsconfig.app.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2022\",\n    \"useDefineForClassFields\": true,\n    \"lib\": [\"ES2022\", \"DOM\", \"DOM.Iterable\"],\n    \"module\": \"ESNext\",\n    \"skipLibCheck\": true,\n    \"moduleResolution\": \"bundler\",\n    \"allowImportingTsExtensions\": true,\n    \"isolatedModules\": true,\n    \"moduleDetection\": \"force\",\n    \"noEmit\": true,\n    \"jsx\": \"react-jsx\",\n    \"strict\": true,\n    \"noUnusedLocals\": true,\n    \"noUnusedParameters\": true,\n    \"noFallthroughCasesInSwitch\": true\n  },\n  \"include\": [\"src\"]\n}\n"
    },
    "tsconfig.json": {
      "kind": "text",
      "content": "{\n  \"files\": [],\n  \"references\": [\n    { \"path\": \"./tsconfig.app.json\" },\n    { \"path\": \"./tsconfig.node.json\" }\n  ]\n}\n"
    },
    "tsconfig.node.json": {
      "kind": "text",
      "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\"ES2023\"],\n    \"module\": \"ESNext\",\n    \"skipLibCheck\": true,\n    \"moduleResolution\": \"bundler\",\n    \"allowImportingTsExtensions\": true,\n    \"isolatedModules\": true,\n    \"moduleDetection\": \"force\",\n    \"noEmit\": true,\n    \"strict\": true\n  },\n  \"include\": [\"vite.config.ts\"]\n}\n"
    },
    "vite.config.ts": {
      "kind": "text",
      "content": "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\n\n// Vite 5.1+ blocks unknown Host headers (DNS-rebinding defense —\n// CVE-2024-28849). Our previews are served at\n// `{shortId}-{sandboxSlug}.{{APP_ZONE}}`; the leading dot matches every\n// subdomain.\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n  server: {\n    host: '0.0.0.0',\n    allowedHosts: ['.{{APP_ZONE}}', 'localhost'],\n  },\n});\n"
    }
  }
};
