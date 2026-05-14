// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared Framework Registry — single source of truth for framework detection,
 * start commands, install commands, and environment variables.
 *
 * Consumed by:
 * - sovereign-shield (workflow.routes.ts) — production deploy via PM2
 * - file-api (preview.service.ts) — dev preview via PM2
 * - preview.ts — bash preview script (generated bash functions)
 * - expose.ts — client-side stack label detection (generated bash)
 */

import fs from 'fs';
import path from 'path';
import { WORKSPACE_NON_PACKAGE_DIRS } from './app-workspace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Runtime =
  | 'node'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'go'
  | 'elixir'
  | 'dart'
  | 'flutter'
  | 'php'
  | 'dotnet'
  | 'java'
  | 'bun'
  | 'static'
  | 'custom';

export interface FrameworkDef {
  id: string;
  runtime: Runtime;
  stackLabel: string;

  // Detection
  marker: string;
  detect?: {
    grep?: string;   // Pattern to grep in marker file
    dep?: string;    // package.json dependency name (Node.js only)
    file?: string;   // Additional file that must exist
  };

  // Use bare binary names ($PORT replaced at runtime). Preview launcher walks
  // node_modules/.bin/ up to sandbox root. NEVER use `npx` — its _npx cache is
  // global per-machine and shadows project-pinned versions. framework.test.ts enforces.
  devCommand: string;
  prodCommand: string;
  buildCommand?: string | null;
  install: string | null;
  prodInstall: string | null;

  env: Record<string, string>;
  devEnv?: Record<string, string>;
  prodEnv?: Record<string, string>;

  // When false, preview.service.ts adds PM2 --watch.
  devWatch?: boolean;

  // Scaffold tree at packages/vps/src/templates/scaffold/trees/<template>/
  scaffold?: {
    template: string;
  };
  scaffoldKind?: 'frontend' | 'backend' | 'monorepo';
  scaffoldPreviewable?: boolean;

  runtimeCheck?: string;
  runtimeInstall?: string;
  /** Server runs but console doesn't show a preview panel (pure backends without OpenAPI). */
  headless?: boolean;
}

// ---------------------------------------------------------------------------
// Registry — ordered by detection priority (most specific first)
// ---------------------------------------------------------------------------

/** Non-Node frameworks — checked when no package.json, or as fallback */
const NON_NODE_FRAMEWORKS: FrameworkDef[] = [
  {
    id: 'rails', runtime: 'ruby', stackLabel: 'Ruby on Rails',
    marker: 'Gemfile', detect: { grep: 'rails' },
    devCommand: 'bundle exec rails server -b 0.0.0.0 -p $PORT',
    prodCommand: 'bundle exec rails server -b 0.0.0.0 -p $PORT -e production',
    install: 'bundle install', prodInstall: 'bundle install --without development test',
    env: { HOST: '0.0.0.0', BINDING: '0.0.0.0' },
    devEnv: { RAILS_ENV: 'development' },
    prodEnv: { RAILS_ENV: 'production' },
    scaffold: { template: 'rails' },
    runtimeCheck: 'ruby', runtimeInstall: 'ruby',
  },
  {
    id: 'sinatra', runtime: 'ruby', stackLabel: 'Sinatra',
    marker: 'Gemfile', detect: { grep: 'sinatra' },
    devCommand: 'bundle exec ruby app.rb -p $PORT -o 0.0.0.0',
    prodCommand: 'bundle exec ruby app.rb -p $PORT -o 0.0.0.0 -e production',
    install: 'bundle install', prodInstall: 'bundle install --without development test',
    env: { HOST: '0.0.0.0' },
    devEnv: {}, prodEnv: {},
    scaffold: { template: 'sinatra' },
    runtimeCheck: 'ruby', runtimeInstall: 'ruby',
    headless: true,
  },
  {
    id: 'ruby', runtime: 'ruby', stackLabel: 'Ruby',
    marker: 'Gemfile',
    devCommand: 'bundle exec ruby app.rb',
    prodCommand: 'bundle exec ruby app.rb',
    install: 'bundle install', prodInstall: 'bundle install --without development test',
    env: { HOST: '0.0.0.0' },
    scaffold: { template: 'ruby' },
    runtimeCheck: 'ruby', runtimeInstall: 'ruby',
    headless: true,
  },
  {
    id: 'django', runtime: 'python', stackLabel: 'Django',
    marker: 'requirements.txt', detect: { file: 'manage.py' },
    devCommand: 'python3 manage.py runserver 0.0.0.0:$PORT',
    prodCommand: 'gunicorn --bind 0.0.0.0:$PORT --workers 2 $(python3 -c "import pathlib; p=next(pathlib.Path(\\".\\").glob(\\"*/wsgi.py\\"), None); print(str(p).replace(\\"/\\",\\".\\").removesuffix(\\".py\\")+\\":application\\" if p else \\"app.wsgi:application\\")")',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt && pip3 install gunicorn',
    env: { HOST: '0.0.0.0' },
    devEnv: {}, prodEnv: {},
    devWatch: true,
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'django' },
  },
  {
    id: 'fastapi', runtime: 'python', stackLabel: 'FastAPI',
    marker: 'requirements.txt', detect: { grep: 'fastapi|uvicorn' },
    devCommand: 'uvicorn $MODULE:app --host 0.0.0.0 --port $PORT --reload',
    prodCommand: 'uvicorn $MODULE:app --host 0.0.0.0 --port $PORT',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt',
    env: { HOST: '0.0.0.0' },
    devWatch: true,
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'fastapi' },
  },
  {
    id: 'flask', runtime: 'python', stackLabel: 'Flask',
    marker: 'requirements.txt', detect: { grep: 'flask' },
    devCommand: 'flask run --host 0.0.0.0 --port $PORT --debug',
    prodCommand: 'gunicorn --bind 0.0.0.0:$PORT --workers 2 app:app',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt && pip3 install gunicorn',
    env: { HOST: '0.0.0.0' },
    devEnv: { FLASK_DEBUG: '1', FLASK_RUN_HOST: '0.0.0.0' },
    prodEnv: { FLASK_RUN_HOST: '0.0.0.0' },
    devWatch: true,
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'flask' },
    headless: true,
  },
  {
    id: 'streamlit', runtime: 'python', stackLabel: 'Streamlit',
    marker: 'requirements.txt', detect: { grep: 'streamlit' },
    devCommand: 'streamlit run app.py --server.port $PORT --server.address 0.0.0.0 --server.headless true',
    prodCommand: 'streamlit run app.py --server.port $PORT --server.address 0.0.0.0 --server.headless true --server.fileWatcherType none --browser.gatherUsageStats false',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt',
    env: {},
    devWatch: true,
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'streamlit' },
  },
  {
    id: 'gradio', runtime: 'python', stackLabel: 'Gradio',
    marker: 'requirements.txt', detect: { grep: 'gradio' },
    devCommand: 'python3 app.py',
    prodCommand: 'python3 app.py',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt',
    env: { GRADIO_SERVER_NAME: '0.0.0.0', GRADIO_SERVER_PORT: '$PORT' },
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'gradio' },
  },
  {
    id: 'python', runtime: 'python', stackLabel: 'Python',
    marker: 'requirements.txt',
    devCommand: 'python3 app.py',
    prodCommand: 'python3 app.py',
    install: 'pip3 install -r requirements.txt', prodInstall: 'pip3 install -r requirements.txt',
    env: { HOST: '0.0.0.0' },
    runtimeCheck: 'python3', runtimeInstall: 'python',
    scaffold: { template: 'python' },
    headless: true,
  },
  {
    id: 'python-pyproject', runtime: 'python', stackLabel: 'Python',
    marker: 'pyproject.toml',
    devCommand: 'python3 app.py',
    prodCommand: 'python3 app.py',
    install: 'pip3 install -e .', prodInstall: 'pip3 install -e .',
    env: { HOST: '0.0.0.0' },
    // No scaffold — pyproject.toml projects are too varied to scaffold generically
  },
  {
    id: 'golang', runtime: 'go', stackLabel: 'Go',
    marker: 'go.mod',
    devCommand: 'go run .',
    prodCommand: './app',
    buildCommand: 'go build -o app .',
    install: null, prodInstall: null,
    env: {},
    scaffold: { template: 'golang' },
    runtimeCheck: 'go', runtimeInstall: 'go',
    headless: true,
  },
  {
    id: 'rust', runtime: 'rust', stackLabel: 'Rust',
    marker: 'Cargo.toml',
    devCommand: 'cargo run',
    prodCommand: './target/release/$(grep -m1 "^name" Cargo.toml | sed "s/.*= *\\\"//;s/\\\".*//")',
    buildCommand: 'cargo build --release',
    install: null, prodInstall: null,
    env: {},
    scaffold: { template: 'rust' },
    runtimeCheck: 'cargo', runtimeInstall: 'rust',
    headless: true,
  },
  {
    id: 'phoenix', runtime: 'elixir', stackLabel: 'Phoenix',
    marker: 'mix.exs', detect: { grep: 'phoenix' },
    devCommand: 'mix run --no-halt',
    prodCommand: 'mix run --no-halt',
    buildCommand: 'mix compile',
    install: 'mix deps.get', prodInstall: 'mix deps.get --only prod',
    env: {},
    devEnv: { MIX_ENV: 'dev' },
    prodEnv: { MIX_ENV: 'prod' },
    devWatch: true,
    scaffold: { template: 'phoenix' },
    runtimeCheck: 'elixir', runtimeInstall: 'elixir',
  },
  {
    id: 'elixir', runtime: 'elixir', stackLabel: 'Elixir',
    marker: 'mix.exs',
    devCommand: 'mix run --no-halt',
    prodCommand: 'mix run --no-halt',
    install: 'mix deps.get', prodInstall: 'mix deps.get --only prod',
    env: {},
    devEnv: { MIX_ENV: 'dev' },
    prodEnv: { MIX_ENV: 'prod' },
    scaffold: { template: 'elixir' },
    runtimeCheck: 'elixir', runtimeInstall: 'elixir',
  },
  {
    id: 'flutter', runtime: 'flutter', stackLabel: 'Flutter',
    marker: 'pubspec.yaml', detect: { grep: 'flutter' },
    devCommand: 'flutter run -d web-server --web-port $PORT --web-hostname 0.0.0.0',
    prodCommand: 'serve build/web -l $PORT --single',
    buildCommand: 'flutter build web',
    install: 'flutter pub get', prodInstall: 'flutter pub get',
    env: {},
    devWatch: true,
    scaffold: { template: 'flutter' },
    runtimeCheck: 'flutter', runtimeInstall: 'flutter',
  },
  {
    id: 'dart', runtime: 'dart', stackLabel: 'Dart',
    marker: 'pubspec.yaml',
    devCommand: 'dart run',
    prodCommand: 'dart run',
    install: 'dart pub get', prodInstall: 'dart pub get',
    env: {},
    scaffold: { template: 'dart' },
    runtimeCheck: 'dart', runtimeInstall: 'dart',
  },
  {
    id: 'laravel', runtime: 'php', stackLabel: 'Laravel',
    marker: 'composer.json', detect: { grep: 'laravel' },
    devCommand: 'php artisan serve --host 0.0.0.0 --port $PORT',
    prodCommand: 'php artisan serve --host 0.0.0.0 --port $PORT',
    install: 'composer install', prodInstall: 'composer install --no-dev',
    env: { PHP_CLI_SERVER_WORKERS: '4' },
    scaffold: { template: 'laravel' },
    runtimeCheck: 'php', runtimeInstall: 'php',
  },
  {
    id: 'php', runtime: 'php', stackLabel: 'PHP',
    marker: 'composer.json',
    devCommand: 'php -S 0.0.0.0:$PORT',
    prodCommand: 'php -S 0.0.0.0:$PORT',
    install: 'composer install', prodInstall: 'composer install --no-dev',
    env: { PHP_CLI_SERVER_WORKERS: '4' },
    scaffold: { template: 'php' },
    runtimeCheck: 'php', runtimeInstall: 'php',
    headless: true,
  },
  // .NET
  {
    id: 'dotnet', runtime: 'dotnet', stackLabel: '.NET',
    marker: '*.csproj',
    devCommand: 'dotnet watch run --urls http://0.0.0.0:$PORT',
    prodCommand: 'dotnet ./publish/$(basename *.csproj .csproj).dll',
    buildCommand: 'dotnet publish -c Release -o ./publish',
    install: 'dotnet restore', prodInstall: 'dotnet restore',
    env: { ASPNETCORE_URLS: 'http://0.0.0.0:$PORT', DOTNET_URLS: 'http://0.0.0.0:$PORT' },
    devWatch: true,
    scaffold: { template: 'dotnet' },
    runtimeCheck: 'dotnet', runtimeInstall: 'dotnet',
  },
  // Java — Spring Boot (Maven)
  {
    id: 'spring-boot', runtime: 'java', stackLabel: 'Spring Boot',
    marker: 'pom.xml', detect: { grep: 'spring-boot' },
    devCommand: './mvnw spring-boot:run -Dspring-boot.run.arguments="--server.port=$PORT --server.address=0.0.0.0"',
    prodCommand: 'java -jar target/*.jar --server.port=$PORT --server.address=0.0.0.0',
    buildCommand: './mvnw package -DskipTests',
    install: './mvnw dependency:resolve', prodInstall: './mvnw dependency:resolve',
    env: { SERVER_PORT: '$PORT', SERVER_ADDRESS: '0.0.0.0' },
    scaffold: { template: 'spring-boot' },
    runtimeCheck: 'java', runtimeInstall: 'java',
  },
  // Java — Spring Boot (Gradle)
  {
    id: 'spring-boot-gradle', runtime: 'java', stackLabel: 'Spring Boot',
    marker: 'build.gradle', detect: { grep: 'spring-boot' },
    devCommand: './gradlew bootRun --args="--server.port=$PORT --server.address=0.0.0.0"',
    prodCommand: 'java -jar build/libs/*.jar --server.port=$PORT --server.address=0.0.0.0',
    buildCommand: './gradlew bootJar',
    install: './gradlew dependencies', prodInstall: './gradlew dependencies',
    env: { SERVER_PORT: '$PORT', SERVER_ADDRESS: '0.0.0.0' },
    scaffold: { template: 'spring-boot-gradle' },
    runtimeCheck: 'java', runtimeInstall: 'java',
  },
  // Java — Maven (generic)
  {
    id: 'java-maven', runtime: 'java', stackLabel: 'Java',
    marker: 'pom.xml',
    devCommand: './mvnw compile exec:java',
    prodCommand: 'java -jar target/*.jar',
    buildCommand: './mvnw package -DskipTests',
    install: './mvnw dependency:resolve', prodInstall: './mvnw dependency:resolve',
    env: {},
    scaffold: { template: 'java-maven' },
    runtimeCheck: 'java', runtimeInstall: 'java',
  },
  // Java — Gradle (generic)
  {
    id: 'java-gradle', runtime: 'java', stackLabel: 'Java',
    marker: 'build.gradle',
    devCommand: './gradlew run',
    prodCommand: 'java -jar build/libs/*.jar',
    buildCommand: './gradlew build -x test',
    install: './gradlew dependencies', prodInstall: './gradlew dependencies',
    env: {},
    scaffold: { template: 'java-gradle' },
    runtimeCheck: 'java', runtimeInstall: 'java',
  },
  // Bun — last so specific markers (Ruby, Python, etc.) win, but catches bun.lockb before Node.js path
  {
    id: 'bun', runtime: 'bun', stackLabel: 'Bun',
    marker: 'bun.lockb',
    devCommand: 'bun run dev',
    prodCommand: 'bun run start',
    install: 'bun install', prodInstall: 'bun install --production',
    env: { HOST: '0.0.0.0' },
    scaffold: { template: 'bun' },
    runtimeCheck: 'bun', runtimeInstall: 'bun',
  },
  {
    id: 'blank', runtime: 'custom', stackLabel: 'Blank',
    marker: 'CLAUDE.md',
    devCommand: 'echo "No preview configured"',
    prodCommand: 'echo "No preview configured"',
    install: null, prodInstall: null,
    env: {},
    devWatch: false,
    scaffold: { template: 'blank' },
    scaffoldPreviewable: false,
  },
];

/** Node.js frameworks — checked when package.json exists, ordered by priority */
const NODE_FRAMEWORKS: FrameworkDef[] = [
  {
    // Turborepo skeleton; follow-up scaffold_project calls drop packages via scaffoldPackageIntoMonorepo.
    id: 'turbo', runtime: 'node', stackLabel: 'Turborepo',
    marker: 'turbo.json',
    devCommand: 'turbo run dev',
    prodCommand: 'turbo run build',
    buildCommand: 'turbo run build',
    install: 'npm install', prodInstall: 'npm install',
    env: {},
    devWatch: false,
    scaffold: { template: 'turbo' },
    scaffoldKind: 'monorepo',
    scaffoldPreviewable: false,
  },
  {
    id: 'next', runtime: 'node', stackLabel: 'Next.js',
    marker: 'package.json', detect: { dep: 'next' },
    devCommand: 'next dev --turbopack -H 0.0.0.0 -p $PORT',
    prodCommand: 'next start -H 0.0.0.0 -p $PORT',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    scaffold: { template: 'next' },
  },
  {
    id: 'nuxt', runtime: 'node', stackLabel: 'Nuxt',
    marker: 'package.json', detect: { dep: 'nuxt' },
    devCommand: 'nuxi dev --port $PORT',
    prodCommand: 'node .output/server/index.mjs',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0', NITRO_HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    scaffold: { template: 'nuxt' },
  },
  {
    id: 'vite', runtime: 'node', stackLabel: 'Vite',
    marker: 'package.json', detect: { dep: 'vite' },
    devCommand: 'vite --port $PORT --host 0.0.0.0',
    prodCommand: 'serve -s dist -l $PORT',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    scaffold: { template: 'vite' },
  },
  {
    id: 'cra', runtime: 'node', stackLabel: 'Create React App',
    marker: 'package.json', detect: { dep: 'react-scripts' },
    devCommand: 'react-scripts start',
    prodCommand: 'serve -s build -l $PORT',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0', DANGEROUSLY_DISABLE_HOST_CHECK: 'true', BROWSER: 'none' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    // CRA deprecated — detect-only for legacy repos; new projects use Vite/Next.
  },
  {
    id: 'svelte', runtime: 'node', stackLabel: 'SvelteKit',
    marker: 'package.json', detect: { dep: '@sveltejs/kit' },
    devCommand: 'vite dev --host 0.0.0.0 --port $PORT',
    prodCommand: 'node build',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    // `sv create` 0.15+ dropped --yes and --add still prompts; use --no-add-ons + pkg overrides.
    scaffold: { template: 'svelte' },
  },
  {
    id: 'astro', runtime: 'node', stackLabel: 'Astro',
    marker: 'package.json', detect: { dep: 'astro' },
    devCommand: 'astro dev --host 0.0.0.0 --port $PORT',
    prodCommand: 'node ./dist/server/entry.mjs',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    // astro.config.mjs override wires @tailwindcss/vite directly (deterministic, no codegen).
    scaffold: { template: 'astro' },
  },
  {
    id: 'gatsby', runtime: 'node', stackLabel: 'Gatsby',
    marker: 'package.json', detect: { dep: 'gatsby' },
    devCommand: 'gatsby develop -p $PORT',
    prodCommand: 'serve -s public -l $PORT',
    buildCommand: 'gatsby build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    // Detect-only for legacy Gatsby repos; no scaffold.
  },
  {
    id: 'remix', runtime: 'node', stackLabel: 'Remix',
    marker: 'package.json', detect: { dep: '@remix-run/dev' },
    devCommand: 'remix vite:dev --host 0.0.0.0 --port $PORT',
    prodCommand: 'remix-serve build/server/index.js',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    scaffold: { template: 'remix' },
  },
  {
    id: 'vue-cli', runtime: 'node', stackLabel: 'Vue CLI',
    marker: 'package.json', detect: { dep: '@vue/cli-service' },
    devCommand: 'vue-cli-service serve --port $PORT',
    prodCommand: 'serve -s dist -l $PORT',
    install: 'npm install', prodInstall: 'npm install --omit=dev',
    env: { HOST: '0.0.0.0' },
    devEnv: { NODE_ENV: 'development' },
    prodEnv: { NODE_ENV: 'production' },
    devWatch: true,
    // Vue-CLI maintenance-mode; detect-only, no scaffold.
  },
  // ── Node.js backend frameworks (detection by dependency) ──
  {
    id: 'hono', runtime: 'node', stackLabel: 'Hono',
    marker: 'package.json', detect: { dep: 'hono' },
    devCommand: 'tsx watch src/index.ts',
    prodCommand: 'tsx src/index.ts',
    install: 'npm install', prodInstall: 'npm install',
    env: { PORT: '$PORT', HOST: '0.0.0.0' },
    devWatch: true,
    // File-only scaffold (create-hono has interactive prompts even with --yes).
    // No Swagger baked in; preview probes /docs, /openapi.json, /swagger, /api-docs at startup.
    scaffold: { template: 'hono' },
  },
  {
    id: 'express', runtime: 'node', stackLabel: 'Express',
    marker: 'package.json', detect: { dep: 'express' },
    devCommand: 'tsx watch src/index.ts',
    prodCommand: 'node dist/index.js',
    install: 'npm install', prodInstall: 'npm install',
    env: { PORT: '$PORT', HOST: '0.0.0.0' },
    devWatch: true,
    // No Swagger baked in; preview probes /docs / /openapi.json at startup.
    scaffold: { template: 'express' },
  },
  {
    id: 'fastify', runtime: 'node', stackLabel: 'Fastify',
    marker: 'package.json', detect: { dep: 'fastify' },
    devCommand: 'tsx watch src/index.ts',
    prodCommand: 'node dist/index.js',
    install: 'npm install', prodInstall: 'npm install',
    env: { PORT: '$PORT', HOST: '0.0.0.0' },
    devWatch: true,
    // No Swagger baked in; preview probes /docs / /openapi.json at startup.
    scaffold: { template: 'fastify' },
  },
  {
    id: 'nestjs', runtime: 'node', stackLabel: 'NestJS',
    marker: 'package.json', detect: { dep: '@nestjs/core' },
    devCommand: 'nest start --watch',
    prodCommand: 'node dist/main',
    buildCommand: 'npm run build',
    install: 'npm install', prodInstall: 'npm install',
    env: { PORT: '$PORT', HOST: '0.0.0.0' },
    devWatch: true,
    // Canonical @nestjs/cli layout. No Swagger baked in; preview probes /docs / /openapi.json.
    scaffold: { template: 'nestjs' },
  },
];

// Framework-reserved dev-server paths (HMR, chunks, sockjs). Used by Caddy dev-route
// generator to rewrite Origin (CVE-2024-28849 allowedDevOrigins/allowedHosts bypass).
export const FRAMEWORK_DEV_PATHS: readonly string[] = [
  // Next.js (pages + app + turbopack)
  "/_next/*",
  "/__nextjs*",
  "/__webpack_hmr",
  // Vite (React, Vue, Svelte, Solid, etc.)
  "/@vite/*",
  "/@fs/*",
  "/@id/*",
  "/@react-refresh",
  "/__vite_ping",
  "/node_modules/.vite/*",
  // Nuxt
  "/_nuxt/*",
  // Astro
  "/_astro/*",
  // SvelteKit
  "/_app/*",
  "/_kit/*",
  // Angular (sockjs-based HMR)
  "/sockjs-node/*",
  // Gatsby
  "/___graphql",
  "/__original-stack-frame",
  "/__webpack-dev-server__/*",
] as const;

/** All frameworks combined for export */
export const FRAMEWORKS: FrameworkDef[] = [...NON_NODE_FRAMEWORKS, ...NODE_FRAMEWORKS];

/** Frameworks that have scaffold commands — IDs only, derived from FRAMEWORKS at module load */
export const SCAFFOLDABLE_FRAMEWORK_IDS: readonly string[] = FRAMEWORKS
  .filter(f => f.scaffold)
  .map(f => f.id);

/** Look up a framework by ID (for scaffold_project tool) */
export function getFrameworkById(id: string): FrameworkDef | undefined {
  return FRAMEWORKS.find(f => f.id === id);
}

// Directories to skip when scanning for app root — shared non-package dir set
// (VCS, tooling caches, build outputs, legitimate non-package siblings).
const SKIP_DIRS = WORKSPACE_NON_PACKAGE_DIRS;

// All marker files we look for
const ALL_MARKERS = [...new Set(FRAMEWORKS.map(f => f.marker))];

// ---------------------------------------------------------------------------
// findAppRoot — locate the actual app directory
// ---------------------------------------------------------------------------

// Find app root by marker: direct → single subdir → fallback to projectPath.
export function findAppRoot(projectPath: string): string {
  // 1. Direct match — project root has framework markers
  if (hasAnyMarker(projectPath)) return projectPath;

  // 2/3. Scan immediate subdirectories, collect ALL matches
  const candidates: string[] = [];
  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const subdir = path.join(projectPath, entry.name);
      if (hasAnyMarker(subdir)) candidates.push(subdir);
    }
  } catch {}

  // Exactly one candidate → safe to auto-resolve
  if (candidates.length === 1) return candidates[0]!;

  // Zero or multiple → return project root (don't guess)
  return projectPath;
}

function hasAnyMarker(dir: string): boolean {
  for (const marker of ALL_MARKERS) {
    if (marker === 'package.json' || marker === '*.csproj') continue; // check these more carefully
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  // package.json
  if (fs.existsSync(path.join(dir, 'package.json'))) return true;
  // *.csproj glob
  try {
    const files = fs.readdirSync(dir);
    if (files.some(f => f.endsWith('.csproj'))) return true;
  } catch {}
  return false;
}

// ---------------------------------------------------------------------------
// detectFramework — identify the stack
// ---------------------------------------------------------------------------

// Priority: ellul.json → Procfile → non-Node markers → package.json deps → scripts → HTML → build dir.
export function detectFramework(appRoot: string): FrameworkDef | null {
  // 1. ellul.json explicit override
  const ellulJson = safeReadJson(path.join(appRoot, 'ellul.json'));
  if (ellulJson) {
    const startCmd = ellulJson.startCommand || ellulJson.deploy?.command;
    if (startCmd) {
      return {
        id: 'custom', runtime: 'custom', stackLabel: 'Custom (ellul.json)',
        marker: 'ellul.json',
        devCommand: ellulJson.startCommand || startCmd,
        prodCommand: ellulJson.deploy?.command || startCmd,
        install: ellulJson.install || null,
        prodInstall: ellulJson.deploy?.install || ellulJson.install || null,
        env: { HOST: '0.0.0.0', ...(ellulJson.env || {}) },
        // Custom commands — unknown if they watch files. PM2 watch as safety net.
      };
    }
  }

  // 2. Procfile
  const procfile = safeReadFile(path.join(appRoot, 'Procfile'));
  if (procfile) {
    const webLine = procfile.split('\n').find(l => /^web\s*:/.test(l));
    if (webLine) {
      const cmd = webLine.replace(/^web\s*:\s*/, '').trim();
      return {
        id: 'procfile', runtime: 'custom', stackLabel: 'Procfile',
        marker: 'Procfile',
        devCommand: cmd,
        prodCommand: cmd,
        install: null, prodInstall: null,
        env: { HOST: '0.0.0.0' },
      };
    }
  }

  // 3. Non-Node markers (fast — no JSON parsing)
  const nonNodeResult = detectNonNode(appRoot);
  if (nonNodeResult) return nonNodeResult;

  // 4–5. Node.js (package.json)
  const nodeResult = detectNode(appRoot);
  if (nodeResult) return nodeResult;

  // 6. Static HTML
  if (fs.existsSync(path.join(appRoot, 'index.html'))) {
    return {
      id: 'static', runtime: 'static', stackLabel: 'Static HTML',
      marker: 'index.html',
      devCommand: 'serve -l $PORT',
      prodCommand: 'serve -s . -l $PORT',
      install: null, prodInstall: null,
      env: {},
      devWatch: true, // Static files — `serve` reads from disk, no process restart needed
    };
  }

  // 7. Build output directories
  for (const outDir of ['dist', 'build', 'out', '.output/public']) {
    if (fs.existsSync(path.join(appRoot, outDir, 'index.html'))) {
      return {
        id: 'static', runtime: 'static', stackLabel: 'Static (build output)',
        marker: `${outDir}/index.html`,
        devCommand: `serve -s ${outDir} -l $PORT`,
        prodCommand: `serve -s ${outDir} -l $PORT`,
        install: null, prodInstall: null,
        env: {},
        devWatch: true, // Static files — served from disk
      };
    }
  }

  return null;
}

function detectNonNode(appRoot: string): FrameworkDef | null {
  for (const fw of NON_NODE_FRAMEWORKS) {
    // Handle glob markers (e.g., *.csproj)
    if (fw.marker.startsWith('*')) {
      const ext = fw.marker.slice(1); // e.g. '.csproj'
      try {
        const files = fs.readdirSync(appRoot);
        if (!files.some(f => f.endsWith(ext))) continue;
      } catch { continue; }
    } else {
      const markerPath = path.join(appRoot, fw.marker);
      if (!fs.existsSync(markerPath)) continue;
    }

    // If framework requires a grep pattern, check it
    if (fw.detect?.grep) {
      // For glob markers, find the first matching file to grep
      let contentToGrep: string | null = null;
      if (fw.marker.startsWith('*')) {
        const ext = fw.marker.slice(1);
        try {
          const files = fs.readdirSync(appRoot);
          const match = files.find(f => f.endsWith(ext));
          if (match) contentToGrep = safeReadFile(path.join(appRoot, match));
        } catch {}
      } else {
        contentToGrep = safeReadFile(path.join(appRoot, fw.marker));
      }
      if (!contentToGrep) continue;
      const pattern = new RegExp(fw.detect.grep, 'i');
      if (!pattern.test(contentToGrep)) continue;
    }

    // If framework requires an additional file, check it
    if (fw.detect?.file) {
      if (!fs.existsSync(path.join(appRoot, fw.detect.file))) continue;
    }

    return fw;
  }
  return null;
}

function detectNode(appRoot: string): FrameworkDef | null {
  const pkgPath = path.join(appRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = safeReadJson(pkgPath);
  if (!pkg) return null; // Invalid JSON — still being written

  const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

  // Check known Node.js frameworks by dependency
  for (const fw of NODE_FRAMEWORKS) {
    if (fw.detect?.dep && allDeps[fw.detect.dep]) {
      return fw;
    }
  }

  // Fallback: check for non-Node markers alongside package.json (mixed projects)
  const nonNodeResult = detectNonNode(appRoot);
  if (nonNodeResult) return nonNodeResult;

  // Node.js scripts fallback
  // Prefer "dev" over "start" — dev scripts typically include file watchers/HMR.
  if (pkg.scripts?.dev) {
    return {
      id: 'node-dev', runtime: 'node', stackLabel: 'Node.js (npm run dev)',
      marker: 'package.json',
      devCommand: 'npm run dev',
      prodCommand: pkg.scripts.start ? 'npm start' : 'npm run dev',
      buildCommand: pkg.scripts.build ? 'npm run build' : undefined,
      install: 'npm install', prodInstall: 'npm install --omit=dev',
      env: { HOST: '0.0.0.0' },
      devEnv: { NODE_ENV: 'development' },
      prodEnv: { NODE_ENV: 'production' },
      devWatch: true, // "dev" scripts typically include nodemon/tsx watch/vite/etc.
    };
  }
  if (pkg.scripts?.start) {
    return {
      id: 'node-start', runtime: 'node', stackLabel: 'Node.js (npm start)',
      marker: 'package.json',
      devCommand: pkg.scripts.dev ? 'npm run dev' : 'npm start',
      prodCommand: 'npm start',
      buildCommand: pkg.scripts.build ? 'npm run build' : undefined,
      install: 'npm install', prodInstall: 'npm install --omit=dev',
      env: { HOST: '0.0.0.0' },
      devEnv: { NODE_ENV: 'development' },
      prodEnv: { NODE_ENV: 'production' },
      // "start" scripts usually don't watch — PM2 watch as safety net
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// getStartCommand / getInstallCommand
// ---------------------------------------------------------------------------

export function getStartCommand(
  fw: FrameworkDef,
  port: number,
  mode: 'dev' | 'production',
): { command: string; env: Record<string, string> } {
  const raw = mode === 'dev' ? fw.devCommand : fw.prodCommand;
  let command = raw.replace(/\$PORT/g, String(port));

  // FastAPI: resolve $MODULE
  if (command.includes('$MODULE')) {
    const candidates = ['main.py', 'app.py', 'server.py', 'api.py'];
    // Note: appRoot not available here — caller should resolve if needed,
    // but for FastAPI the module is typically in CWD
    command = command.replace(/\$MODULE/g, 'main');
  }

  const env: Record<string, string> = {
    PORT: String(port),
    ...fw.env,
    ...(mode === 'dev' ? fw.devEnv : fw.prodEnv),
  };

  return { command, env };
}

export function resolveModule(appRoot: string): string {
  const candidates = ['main.py', 'app.py', 'server.py', 'api.py'];
  const found = candidates.find(f => fs.existsSync(path.join(appRoot, f)));
  return found ? found.replace('.py', '') : 'main';
}

export function getInstallCommand(fw: FrameworkDef, mode: 'dev' | 'production'): string | null {
  return mode === 'dev' ? fw.install : fw.prodInstall;
}

// ---------------------------------------------------------------------------
// Package Manager Detection
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageManagerInfo {
  pm: PackageManager;
  lockfile: string;         // filename: 'pnpm-lock.yaml' | 'yarn.lock' | 'package-lock.json' | 'bun.lockb' | 'bun.lock'
  lockfilePath: string;     // absolute path to found lockfile ('' if none found)
  installDev: string;       // full install (devDeps included)
  installProd: string;      // production-only install
  prune: string | null;     // prune devDeps after build (null for yarn — use installProd instead)
  preferOffline: string;    // flag to append, or '' if PM is offline-first
  // Explicit `run` keyword — both yarn classic and berry accept it; consistent across PMs.
  scriptRunner: string;
}

// Order is load-bearing: bun first so an explicit bun.lockb wins over stale package-lock.json.
const PM_LOCKFILES: { pm: PackageManager; file: string }[] = [
  { pm: 'bun', file: 'bun.lockb' },
  { pm: 'bun', file: 'bun.lock' },
  { pm: 'pnpm', file: 'pnpm-lock.yaml' },
  { pm: 'yarn', file: 'yarn.lock' },
  { pm: 'npm', file: 'package-lock.json' },
];

// Detect PM by walk-up: packageManager field (corepack) → non-empty lockfile → npm fallback.
// Empty lockfiles (create-next-app probe artifacts) ignored — they'd cause command-not-found.
export function detectPackageManager(
  appRoot: string,
  boundary?: string,
): PackageManagerInfo {
  const stop = boundary || '/';
  let dir = appRoot;

  // Pass 1: walk up looking for an explicit packageManager declaration.
  // This is the authoritative signal — every other source is heuristic.
  // bun also landed support for a `packageManager` field (`bun@1.x`);
  // accept it alongside the corepack trio.
  let pmDir = dir;
  while (true) {
    const pkgJsonPath = path.join(pmDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { packageManager?: string };
        if (typeof pkg.packageManager === 'string') {
          const m = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager);
          if (m) {
            const declared = m[1] as PackageManager;
            const lockFile = PM_LOCKFILES.find(p => p.pm === declared)?.file ?? 'package-lock.json';
            const lockPath = path.join(pmDir, lockFile);
            return buildPmInfo(declared, lockFile, fs.existsSync(lockPath) ? lockPath : '');
          }
        }
      } catch { /* unparseable — keep walking */ }
    }
    const parent = path.dirname(pmDir);
    if (parent === pmDir || !pmDir.startsWith(stop)) break;
    pmDir = parent;
  }

  // Pass 2: walk up looking for a non-empty lockfile.
  while (true) {
    for (const { pm, file } of PM_LOCKFILES) {
      const candidate = path.join(dir, file);
      if (!fs.existsSync(candidate)) continue;
      try {
        if (fs.statSync(candidate).size === 0) continue;
      } catch { continue; }
      return buildPmInfo(pm, file, candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir || !dir.startsWith(stop)) break;
    dir = parent;
  }

  // Default: npm (no signal at all — universal fallback)
  return buildPmInfo('npm', 'package-lock.json', '');
}

function buildPmInfo(pm: PackageManager, lockfile: string, lockfilePath: string): PackageManagerInfo {
  switch (pm) {
    case 'pnpm':
      return {
        pm, lockfile, lockfilePath,
        installDev: 'pnpm install',
        installProd: 'pnpm install --prod',
        prune: 'pnpm prune --prod',
        preferOffline: '',  // pnpm is offline-first by default
        scriptRunner: 'pnpm run',
      };
    case 'yarn':
      return {
        pm, lockfile, lockfilePath,
        installDev: 'yarn install',
        installProd: 'yarn install --production',
        prune: null,  // yarn has no prune; use installProd instead
        preferOffline: '--prefer-offline',
        scriptRunner: 'yarn run',
      };
    case 'bun':
      return {
        pm, lockfile, lockfilePath,
        installDev: 'bun install',
        installProd: 'bun install --production',
        prune: null,  // bun has no separate prune — use installProd instead
        preferOffline: '',  // bun caches aggressively by default
        scriptRunner: 'bun run',
      };
    case 'npm':
    default:
      return {
        pm, lockfile, lockfilePath,
        installDev: 'npm install',
        installProd: 'npm install --omit=dev',
        prune: 'npm prune --omit=dev',
        preferOffline: '--prefer-offline',
        scriptRunner: 'npm run',
      };
  }
}

// ---------------------------------------------------------------------------
// Bash generators — produce bash code from the registry
// ---------------------------------------------------------------------------

// Bash port of detectFramework().
export function generateBashDetectFramework(): string {
  const lines: string[] = [];
  lines.push('detect_framework() {');
  lines.push('  local dir="$1"');
  lines.push('');

  // Bun detection — must come before package.json check since Bun projects have both
  lines.push('  # Bun detection (bun.lockb can coexist with package.json)');
  lines.push('  if [ -f "$dir/bun.lockb" ]; then echo "bun" && return; fi');
  lines.push('');

  // Non-Node detection (before package.json check)
  lines.push('  # Non-Node detection (before package.json check)');
  lines.push('  if [ ! -f "$dir/package.json" ]; then');

  // Group non-node frameworks by marker (exclude bun — handled above)
  const markerGroups = new Map<string, FrameworkDef[]>();
  for (const fw of NON_NODE_FRAMEWORKS) {
    if (fw.marker === 'bun.lockb') continue; // handled above
    const list = markerGroups.get(fw.marker) || [];
    list.push(fw);
    markerGroups.set(fw.marker, list);
  }

  let firstMarker = true;
  for (const [marker, fws] of markerGroups) {
    const indent = '    ';
    const isGlob = marker.startsWith('*');

    // Glob markers (e.g. *.csproj) need ls-based check
    if (isGlob) {
      lines.push(`${indent}if ls "$dir"/${marker} >/dev/null 2>&1; then`);
    } else {
      lines.push(`${indent}if [ -f "$dir/${marker}" ]; then`);
    }

    // Special case: django needs manage.py check before general requirements.txt
    const djangoFw = fws.find(f => f.id === 'django');
    const otherFws = fws.filter(f => f.id !== 'django');

    if (djangoFw && marker === 'requirements.txt') {
      // Django must be before the general requirements.txt check
      // But django is detect: { file: 'manage.py' } — it's handled separately
    }

    let first = true;
    for (const fw of fws) {
      if (fw.detect?.file) {
        // Additional file check (django)
        lines.push(`${indent}  if [ -f "$dir/${fw.detect.file}" ]; then echo "${fw.id}" && return; fi`);
      } else if (fw.detect?.grep) {
        const grepPattern = fw.detect.grep.replace(/\|/g, '\\|');
        // For glob markers, grep against the first matching file
        if (isGlob) {
          const ext = marker.slice(1);
          lines.push(`${indent}  ${first ? 'if' : 'elif'} grep -qi '${grepPattern}' "$dir"/${marker} 2>/dev/null; then echo "${fw.id}"`);
        } else {
          lines.push(`${indent}  ${first ? 'if' : 'elif'} grep -qi '${grepPattern}' "$dir/${marker}" 2>/dev/null; then echo "${fw.id}"`);
        }
        first = false;
      } else {
        // Fallback for this marker (no detect criteria)
        if (!first) {
          lines.push(`${indent}  else echo "${fw.id}"`);
        } else {
          lines.push(`${indent}  echo "${fw.id}"`);
        }
      }
    }

    if (!first) {
      lines.push(`${indent}  fi`);
    }
    lines.push(`${indent}  return`);
    lines.push(`${indent}fi`);
    firstMarker = false;
  }

  // Static HTML fallback (no package manager files)
  lines.push('    if ls "$dir"/*.html >/dev/null 2>&1; then echo "static" && return; fi');
  lines.push('    echo "static" && return');
  lines.push('  fi');
  lines.push('');

  // Node.js: validate package.json
  lines.push('  # Node.js: validate package.json');
  lines.push('  local pkg');
  lines.push('  pkg=$(cat "$dir/package.json" 2>/dev/null)');
  lines.push('  echo "$pkg" | node -e "try{JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\'))}catch{process.exit(1)}" 2>/dev/null');
  lines.push('  if [ $? -ne 0 ]; then');
  lines.push('    echo "pending"');
  lines.push('    return');
  lines.push('  fi');

  // Node.js framework detection by dependency
  let firstNode = true;
  for (const fw of NODE_FRAMEWORKS) {
    if (!fw.detect?.dep) continue;
    const keyword = `"${fw.detect.dep}"`;
    lines.push(`  ${firstNode ? 'if' : 'elif'} echo "$pkg" | grep -q '${keyword}'; then echo "${fw.id}"`);
    firstNode = false;
  }

  // Node.js scripts fallback
  lines.push(`  elif echo "$pkg" | grep -q '"scripts"' && echo "$pkg" | grep -q '"dev"'; then echo "npm-dev"`);

  // Fallback: check for non-Node markers alongside package.json
  lines.push('  # Fallback: check for non-Node markers alongside package.json');
  lines.push('  elif [ -f "$dir/Gemfile" ]; then');
  lines.push('    if grep -q \'rails\' "$dir/Gemfile" 2>/dev/null; then echo "rails"');
  lines.push('    elif grep -q \'sinatra\' "$dir/Gemfile" 2>/dev/null; then echo "sinatra"');
  lines.push('    else echo "ruby"');
  lines.push('    fi');
  lines.push('  else echo "static"');
  lines.push('  fi');
  lines.push('}');

  return lines.join('\n');
}

export function generateBashGetCommand(mode: 'dev' | 'production'): string {
  const fnName = mode === 'dev' ? 'get_dev_command' : 'get_prod_command';
  const lines: string[] = [];
  lines.push(`${fnName}() {`);
  lines.push('  local framework="$1"');
  lines.push('  case "$framework" in');

  const allFws = [...NON_NODE_FRAMEWORKS, ...NODE_FRAMEWORKS];
  const seen = new Set<string>();
  for (const fw of allFws) {
    if (seen.has(fw.id)) continue;
    seen.add(fw.id);
    const cmd = mode === 'dev' ? fw.devCommand : fw.prodCommand;
    lines.push(`    ${fw.id})${' '.repeat(Math.max(1, 12 - fw.id.length))}echo "${cmd}" ;;`);
  }

  // npm-dev alias (maps to node-dev in TypeScript but "npm-dev" in bash)
  if (!seen.has('npm-dev')) {
    lines.push('    npm-dev)    echo "npm run dev" ;;');
  }

  lines.push('    *)          echo "" ;;');
  lines.push('  esac');
  lines.push('}');

  return lines.join('\n');
}

export function generateBashWaitForInstall(): string {
  const lines: string[] = [];
  lines.push('wait_for_install() {');
  lines.push('  local dir="$1"');
  lines.push('  local framework="$2"');
  lines.push('');
  lines.push('  # Non-Node frameworks: handle their own package managers');
  lines.push('  case "$framework" in');

  // Group by install command pattern
  // Ruby
  lines.push('    rails|sinatra|ruby)');
  lines.push('      [ ! -f "$dir/Gemfile" ] && return 0');
  lines.push('      if [ ! -f "$dir/Gemfile.lock" ] || [ ! -d "$dir/vendor/bundle" ]; then');
  lines.push('        log "Running bundle install..."');
  lines.push('        cd "$dir" && bundle install 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Python
  lines.push('    django|flask|fastapi|streamlit|python|python-pyproject)');
  lines.push('      if [ -f "$dir/requirements.txt" ]; then');
  lines.push('        log "Running pip install..."');
  lines.push('        cd "$dir" && pip install -r requirements.txt 2>&1 | tail -5');
  lines.push('      elif [ -f "$dir/pyproject.toml" ]; then');
  lines.push('        log "Running pip install -e ."');
  lines.push('        cd "$dir" && pip install -e . 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Rust/Go
  lines.push('    rust|golang)');
  lines.push('      return 0  # cargo run / go run handle deps automatically');
  lines.push('      ;;');

  // Elixir
  lines.push('    phoenix|elixir)');
  lines.push('      [ ! -f "$dir/mix.exs" ] && return 0');
  lines.push('      if [ ! -f "$dir/mix.lock" ] || [ ! -d "$dir/deps" ]; then');
  lines.push('        log "Running mix deps.get..."');
  lines.push('        cd "$dir" && mix deps.get 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Flutter
  lines.push('    flutter)');
  lines.push('      [ ! -f "$dir/pubspec.yaml" ] && return 0');
  lines.push('      if [ ! -d "$dir/.dart_tool" ]; then');
  lines.push('        log "Running flutter pub get..."');
  lines.push('        cd "$dir" && flutter pub get 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Dart
  lines.push('    dart)');
  lines.push('      [ ! -f "$dir/pubspec.yaml" ] && return 0');
  lines.push('      if [ ! -d "$dir/.dart_tool" ]; then');
  lines.push('        log "Running dart pub get..."');
  lines.push('        cd "$dir" && dart pub get 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // PHP
  lines.push('    laravel|php)');
  lines.push('      [ ! -f "$dir/composer.json" ] && return 0');
  lines.push('      if [ ! -d "$dir/vendor" ]; then');
  lines.push('        log "Running composer install..."');
  lines.push('        cd "$dir" && composer install 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // .NET
  lines.push('    dotnet)');
  lines.push('      if ! ls "$dir"/*.csproj >/dev/null 2>&1; then return 0; fi');
  lines.push('      log "Running dotnet restore..."');
  lines.push('      cd "$dir" && dotnet restore 2>&1 | tail -5');
  lines.push('      return 0');
  lines.push('      ;;');

  // Java (Maven)
  lines.push('    spring-boot|java-maven)');
  lines.push('      [ ! -f "$dir/pom.xml" ] && return 0');
  lines.push('      if [ -f "$dir/mvnw" ]; then');
  lines.push('        chmod +x "$dir/mvnw"');
  lines.push('        log "Running Maven dependency resolve..."');
  lines.push('        cd "$dir" && ./mvnw dependency:resolve 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Java (Gradle)
  lines.push('    spring-boot-gradle|java-gradle)');
  lines.push('      [ ! -f "$dir/build.gradle" ] && return 0');
  lines.push('      if [ -f "$dir/gradlew" ]; then');
  lines.push('        chmod +x "$dir/gradlew"');
  lines.push('        log "Running Gradle dependencies..."');
  lines.push('        cd "$dir" && ./gradlew dependencies 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  // Bun
  lines.push('    bun)');
  lines.push('      [ ! -f "$dir/bun.lockb" ] && return 0');
  lines.push('      if [ ! -d "$dir/node_modules" ]; then');
  lines.push('        log "Running bun install..."');
  lines.push('        cd "$dir" && bun install 2>&1 | tail -5');
  lines.push('      fi');
  lines.push('      return 0');
  lines.push('      ;;');

  lines.push('  esac');
  lines.push('');

  // Node.js frameworks: WAIT for node_modules (never install — preview.service
  // is the single install executor with curated env). The bash daemon only
  // polls until the expected binary appears or the timeout expires.
  lines.push('  # Node.js frameworks: wait for node_modules (poll only, never install)');
  lines.push('  [ ! -f "$dir/package.json" ] && return 0');
  lines.push('');
  lines.push('  local expected_bin=""');
  lines.push('  case "$framework" in');
  lines.push('    vite|svelte|remix) expected_bin="node_modules/.bin/vite" ;;');
  lines.push('    next)     expected_bin="node_modules/.bin/next" ;;');
  lines.push('    cra)      expected_bin="node_modules/.bin/react-scripts" ;;');
  lines.push('    astro)    expected_bin="node_modules/.bin/astro" ;;');
  lines.push('    nuxt)     expected_bin="node_modules/.bin/nuxi" ;;');
  lines.push('    gatsby)   expected_bin="node_modules/.bin/gatsby" ;;');
  lines.push('    vue-cli)  expected_bin="node_modules/.bin/vue-cli-service" ;;');
  lines.push('    turbo)    expected_bin="node_modules/.bin/turbo" ;;');
  lines.push('    hono|express|fastify|koa|nestjs) expected_bin="node_modules/.bin/tsx" ;;');
  lines.push('    npm-dev|node-start|node-dev) expected_bin="node_modules" ;;');
  lines.push('    *)        expected_bin="node_modules" ;;');
  lines.push('  esac');
  lines.push('');
  lines.push('  # Check locally first');
  lines.push('  if [ -e "$dir/$expected_bin" ]; then');
  lines.push('    return 0');
  lines.push('  fi');
  lines.push('');
  lines.push('  # Workspace monorepos: dependencies may be hoisted to a parent node_modules.');
  lines.push('  # Walk up from package dir toward PROJECTS_DIR to find hoisted binaries.');
  lines.push('  local hoisted_root=""');
  lines.push('  local _search="$dir"');
  lines.push('  while [ "$_search" != "$PROJECTS_DIR" ] && [ "$(dirname "$_search")" != "$_search" ]; do');
  lines.push('    _search=$(dirname "$_search")');
  lines.push('    if [ -e "$_search/$expected_bin" ]; then');
  lines.push('      return 0  # Already installed (hoisted)');
  lines.push('    fi');
  lines.push('    # Remember the workspace root (has package.json with workspaces field)');
  lines.push('    if [ -z "$hoisted_root" ] && [ -f "$_search/package.json" ]; then');
  lines.push('      if node -e "try{const p=JSON.parse(require(\'fs\').readFileSync(\'$_search/package.json\',\'utf8\'));process.exit(p.workspaces?0:1)}catch{process.exit(1)}" 2>/dev/null; then');
  lines.push('        hoisted_root="$_search"');
  lines.push('      fi');
  lines.push('    fi');
  lines.push('    [ "$_search" = "$PROJECTS_DIR" ] && break');
  lines.push('  done');
  lines.push('');
  lines.push('  # Poll until install lands — preview.service.ts runs the actual install');
  lines.push('  # with NODE_ENV=development and npm_config_include=dev so devDeps land.');
  lines.push('  # This daemon must NOT run its own install: concurrent npm processes at');
  lines.push('  # the same workspace root corrupt lockfiles and node_modules.');
  lines.push('  log "Waiting for install to complete ($expected_bin)..."');
  lines.push('  local waited=0');
  lines.push('  while [ $waited -lt $MAX_READINESS_WAIT ]; do');
  lines.push('    # Check both local and hoisted locations');
  lines.push('    [ -e "$dir/$expected_bin" ] && return 0');
  lines.push('    if [ -n "$hoisted_root" ] && [ -e "$hoisted_root/$expected_bin" ]; then');
  lines.push('      return 0');
  lines.push('    fi');
  lines.push('    sleep 2');
  lines.push('    waited=$((waited + 2))');
  lines.push('  done');
  lines.push('  log "WARNING: Install did not complete within ${MAX_READINESS_WAIT}s"');
  lines.push('  return 1');
  lines.push('}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runtime Constants
// ---------------------------------------------------------------------------

/** Allowed runtime names for the install endpoint (single source of truth for validation) */
export const ALLOWED_RUNTIMES = ['ruby', 'go', 'rust', 'elixir', 'php', 'dart', 'flutter', 'dotnet', 'java', 'bun'] as const;
export type InstallableRuntime = (typeof ALLOWED_RUNTIMES)[number];

// Bash ensure_runtime(): flock-serialized, 300s cap, matches TS ensureRuntimeInstalled().
export function generateBashEnsureRuntime(): string {
  const lines: string[] = [];
  lines.push('ensure_runtime() {');
  lines.push('  local framework="$1"');
  lines.push('  local runtime=""');
  lines.push('  local check_bin=""');
  lines.push('');
  lines.push('  case "$framework" in');
  lines.push('    rails|sinatra|ruby)  runtime="ruby";   check_bin="ruby"   ;;');
  lines.push('    golang)              runtime="go";      check_bin="go"     ;;');
  lines.push('    rust)                runtime="rust";    check_bin="cargo"  ;;');
  lines.push('    phoenix|elixir)      runtime="elixir";  check_bin="elixir" ;;');
  lines.push('    laravel|php)         runtime="php";     check_bin="php"    ;;');
  lines.push('    dart)                runtime="dart";    check_bin="dart"   ;;');
  lines.push('    flutter)             runtime="flutter"; check_bin="flutter";;');
  lines.push('    dotnet)              runtime="dotnet";  check_bin="dotnet" ;;');
  lines.push('    spring-boot|spring-boot-gradle|java-maven|java-gradle) runtime="java"; check_bin="java" ;;');
  lines.push('    bun)                 runtime="bun";     check_bin="bun"    ;;');
  lines.push('    *)                   return 0 ;;  # Node/Python/static: pre-installed');
  lines.push('  esac');
  lines.push('');
  lines.push('  # Fast path: binary already on PATH (systemd unit sets expanded PATH)');
  lines.push('  hash -r 2>/dev/null');
  lines.push('  if command -v "$check_bin" >/dev/null 2>&1; then');
  lines.push('    return 0');
  lines.push('  fi');
  lines.push('');
  lines.push('  log "Runtime $runtime not found, installing..."');
  lines.push('');
  lines.push('  # Serialize concurrent installs of the same runtime via flock.');
  lines.push('  # The install script is idempotent, so if a prior holder already installed,');
  lines.push('  # the script exits 0 immediately (command -v check inside the script).');
  lines.push('  local lockfile="/var/run/ellul-install-${runtime}.lock"');
  lines.push('  local install_log');
  lines.push('  install_log=$(mktemp /tmp/ellul-install-XXXXXX.log)');
  lines.push('');
  lines.push('  # timeout 300s matches the TS ensureRuntimeInstalled() 5-min cap.');
  lines.push('  # flock -w 300 waits up to 300s for the lock (covers case where another');
  lines.push('  # process is already installing). Total worst case: 300s lock wait + 300s install.');
  lines.push('  if ! timeout 300 flock -w 300 "$lockfile" \\');
  lines.push('       sudo /usr/local/bin/ellul-install-runtime "$runtime" \\');
  lines.push('       >"$install_log" 2>&1; then');
  lines.push('    log "ERROR: Runtime $runtime installation failed (exit $?). Output:"');
  lines.push('    cat "$install_log" | while IFS= read -r line; do log "  $line"; done');
  lines.push('    rm -f "$install_log"');
  lines.push('    return 1');
  lines.push('  fi');
  lines.push('  rm -f "$install_log"');
  lines.push('');
  lines.push('  # Verify binary is now available. The install script is synchronous so the');
  lines.push('  # binary should be present immediately. Poll briefly to handle PATH/hash lag.');
  lines.push('  local waited=0');
  lines.push('  while [ $waited -lt 30 ]; do');
  lines.push('    hash -r 2>/dev/null');
  lines.push('    if command -v "$check_bin" >/dev/null 2>&1; then');
  lines.push('      log "Runtime $runtime installed successfully"');
  lines.push('      return 0');
  lines.push('    fi');
  lines.push('    sleep 2');
  lines.push('    waited=$((waited + 2))');
  lines.push('  done');
  lines.push('');
  lines.push('  log "ERROR: Runtime $runtime install exited 0 but $check_bin not found on PATH"');
  lines.push('  return 1');
  lines.push('}');
  return lines.join('\n');
}

export function generateBashStackDetect(): string {
  const lines: string[] = [];
  lines.push('# ── Detect stack (harmless, runs in user space) ───────────────────');
  lines.push('PROJECT_PATH="$(pwd)"');
  lines.push('STACK="Unknown"');
  lines.push('');

  // findAppRoot equivalent in bash
  lines.push('# Find app root (check subdirs if no marker in PROJECT_PATH)');
  lines.push('APP_ROOT="$PROJECT_PATH"');
  lines.push(`MARKERS="package.json Gemfile requirements.txt pyproject.toml go.mod Cargo.toml mix.exs pubspec.yaml composer.json"`);
  lines.push('found_marker=false');
  lines.push('for m in $MARKERS; do');
  lines.push('  if [ -f "$PROJECT_PATH/$m" ]; then found_marker=true; break; fi');
  lines.push('done');
  lines.push('if [ "$found_marker" = "false" ]; then');
  lines.push('  for d in "$PROJECT_PATH"/*/; do');
  lines.push('    [ ! -d "$d" ] && continue');
  lines.push('    dname=$(basename "$d")');
  lines.push('    case "$dname" in .git|node_modules|.zeroclaw|vendor|__pycache__|.bundle) continue ;; esac');
  lines.push('    for m in $MARKERS; do');
  lines.push('      if [ -f "$d$m" ]; then APP_ROOT="$d"; found_marker=true; break 2; fi');
  lines.push('    done');
  lines.push('  done');
  lines.push('fi');
  lines.push('');

  // Node.js detection
  lines.push('if [ -f "$APP_ROOT/package.json" ]; then');
  for (const fw of NODE_FRAMEWORKS) {
    if (!fw.detect?.dep) continue;
    lines.push(`  if grep -q '"${fw.detect.dep}"' "$APP_ROOT/package.json" 2>/dev/null; then`);
    lines.push(`    STACK="${fw.stackLabel}"`);
    // For express/hono/fastify — check common non-framework deps
    lines.push(`  el`);
  }
  // Also check for common server frameworks not in NODE_FRAMEWORKS
  const serverFrameworks = [
    { dep: 'express', label: 'Express' },
    { dep: 'hono', label: 'Hono' },
    { dep: 'fastify', label: 'Fastify' },
  ];
  for (const sf of serverFrameworks) {
    lines.push(`  if grep -q '"${sf.dep}"' "$APP_ROOT/package.json" 2>/dev/null; then`);
    lines.push(`    STACK="${sf.label}"`);
    lines.push(`  el`);
  }

  // Hmm, this approach is getting messy. Let me restructure it as a simpler if/elif chain.
  // Let me rewrite this function properly.

  const lines2: string[] = [];
  lines2.push('# ── Detect stack (harmless, runs in user space) ───────────────────');
  lines2.push('PROJECT_PATH="$(pwd)"');
  lines2.push('STACK="Unknown"');
  lines2.push('');

  // findAppRoot equivalent in bash
  lines2.push('# Find app root (check subdirs if no marker in PROJECT_PATH)');
  lines2.push('APP_ROOT="$PROJECT_PATH"');
  lines2.push('MARKERS="package.json Gemfile requirements.txt pyproject.toml go.mod Cargo.toml mix.exs pubspec.yaml composer.json pom.xml build.gradle bun.lockb"');
  lines2.push('found_marker=false');
  lines2.push('for m in $MARKERS; do');
  lines2.push('  if [ -f "$PROJECT_PATH/$m" ]; then found_marker=true; break; fi');
  lines2.push('done');
  lines2.push('# Check glob markers (*.csproj)');
  lines2.push('if [ "$found_marker" = "false" ] && ls "$PROJECT_PATH"/*.csproj >/dev/null 2>&1; then found_marker=true; fi');
  lines2.push('if [ "$found_marker" = "false" ]; then');
  lines2.push('  for d in "$PROJECT_PATH"/*/; do');
  lines2.push('    [ ! -d "$d" ] && continue');
  lines2.push('    dname=$(basename "$d")');
  lines2.push('    case "$dname" in .git|node_modules|.zeroclaw|vendor|__pycache__|.bundle) continue ;; esac');
  lines2.push('    for m in $MARKERS; do');
  lines2.push('      if [ -f "$d$m" ]; then APP_ROOT="${d%/}"; found_marker=true; break 2; fi');
  lines2.push('    done');
  lines2.push('    if ls "$d"*.csproj >/dev/null 2>&1; then APP_ROOT="${d%/}"; found_marker=true; break; fi');
  lines2.push('  done');
  lines2.push('fi');
  lines2.push('');

  // Bun detection (before Node.js — Bun projects also have package.json)
  lines2.push('if [ -f "$APP_ROOT/bun.lockb" ]; then');
  lines2.push('  STACK="Bun"');

  // Node.js
  lines2.push('elif [ -f "$APP_ROOT/package.json" ]; then');

  const allNodeDeps = [
    ...NODE_FRAMEWORKS.filter(f => f.detect?.dep).map(f => ({ dep: f.detect!.dep!, label: f.stackLabel })),
    { dep: 'react', label: 'React' },
    { dep: 'express', label: 'Express' },
    { dep: 'hono', label: 'Hono' },
    { dep: 'fastify', label: 'Fastify' },
  ];

  let isFirst = true;
  for (const { dep, label } of allNodeDeps) {
    lines2.push(`  ${isFirst ? 'if' : 'elif'} grep -q '"${dep}"' "$APP_ROOT/package.json" 2>/dev/null; then`);
    lines2.push(`    STACK="${label}"`);
    isFirst = false;
  }
  lines2.push('  else');
  lines2.push('    STACK="Node.js"');
  lines2.push('  fi');
  lines2.push('  if [ -f "$APP_ROOT/tsconfig.json" ]; then');
  lines2.push('    STACK="$STACK/TS"');
  lines2.push('  fi');

  // Non-Node markers
  const nonNodeStacks: Array<{ marker: string; checks?: Array<{ grep: string; label: string }>; fallback: string }> = [
    {
      marker: 'Gemfile',
      checks: [{ grep: 'rails', label: 'Ruby on Rails' }, { grep: 'sinatra', label: 'Sinatra' }],
      fallback: 'Ruby',
    },
    {
      marker: 'requirements.txt',
      checks: [{ grep: 'fastapi', label: 'FastAPI' }, { grep: 'flask', label: 'Flask' }, { grep: 'django', label: 'Django' }, { grep: 'streamlit', label: 'Streamlit' }],
      fallback: 'Python',
    },
    { marker: 'pyproject.toml', fallback: 'Python' },
    { marker: 'go.mod', fallback: 'Go' },
    { marker: 'Cargo.toml', fallback: 'Rust' },
    {
      marker: 'mix.exs',
      checks: [{ grep: 'phoenix', label: 'Phoenix' }],
      fallback: 'Elixir',
    },
    {
      marker: 'pubspec.yaml',
      checks: [{ grep: 'flutter', label: 'Flutter' }],
      fallback: 'Dart',
    },
    {
      marker: 'composer.json',
      checks: [{ grep: 'laravel', label: 'Laravel' }],
      fallback: 'PHP',
    },
    {
      marker: 'pom.xml',
      checks: [{ grep: 'spring-boot', label: 'Spring Boot' }],
      fallback: 'Java',
    },
    {
      marker: 'build.gradle',
      checks: [{ grep: 'spring-boot', label: 'Spring Boot' }],
      fallback: 'Java',
    },
  ];

  for (const { marker, checks, fallback } of nonNodeStacks) {
    lines2.push(`elif [ -f "$APP_ROOT/${marker}" ]; then`);
    if (checks && checks.length > 0) {
      let first = true;
      for (const { grep, label } of checks) {
        lines2.push(`  ${first ? 'if' : 'elif'} grep -qi "${grep}" "$APP_ROOT/${marker}" 2>/dev/null; then`);
        lines2.push(`    STACK="${label}"`);
        first = false;
      }
      lines2.push('  else');
      lines2.push(`    STACK="${fallback}"`);
      lines2.push('  fi');
    } else {
      lines2.push(`  STACK="${fallback}"`);
    }
  }

  // .NET glob marker (*.csproj)
  lines2.push('elif ls "$APP_ROOT"/*.csproj >/dev/null 2>&1; then');
  lines2.push('  STACK=".NET"');

  lines2.push('fi');

  return lines2.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(filePath: string): any {
  const content = safeReadFile(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
