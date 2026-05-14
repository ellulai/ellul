// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useMemo } from "react";
import { RefreshCw, Copy, Check, BookOpen, Code2, ExternalLink, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useOpenApiSpec } from "@/hooks/useOpenApiSpec";
import { cn } from "@/lib/utils";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

interface ApiDocsPreviewProps {
  app: AppInfo;
  devDomain: string;
  serverDomain: string;
  isPreviewActive: boolean;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, SchemaObject> };
  tags?: Array<{ name: string; description?: string }>;
}

interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  operationId?: string;
  deprecated?: boolean;
}

interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
}

interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject; examples?: Record<string, { summary?: string; value?: unknown }> }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  example?: unknown;
  description?: string;
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

const METHOD_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  get:    { bg: "bg-sodium/10", text: "text-sodium", border: "border-sodium/20" },
  post:   { bg: "bg-blue-500/10",    text: "text-blue-400",    border: "border-blue-500/20" },
  put:    { bg: "bg-sodium/10",   text: "text-sodium",   border: "border-sodium/20" },
  patch:  { bg: "bg-sodium/10",  text: "text-sodium",  border: "border-sodium/20" },
  delete: { bg: "bg-terra/10",     text: "text-terra",     border: "border-terra/20" },
};

function getMethodStyle(method: string) {
  return METHOD_STYLES[method.toLowerCase()] ?? { bg: "bg-cream/[0.04]", text: "text-cream/60", border: "border-cream/[0.08]/20" };
}

function resolveRef(ref: string, spec: OpenApiSpec): SchemaObject | null {
  // "#/components/schemas/User" → spec.components.schemas.User
  const parts = ref.replace("#/", "").split("/");
  let obj: unknown = spec;
  for (const p of parts) {
    if (obj && typeof obj === "object") obj = (obj as Record<string, unknown>)[p];
    else return null;
  }
  return (obj as SchemaObject) ?? null;
}

function resolveSchema(schema: SchemaObject | undefined, spec: OpenApiSpec): SchemaObject | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return resolveRef(schema.$ref, spec) ?? undefined;
  return schema;
}

function getRefName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function getSchemaTypeName(schema: SchemaObject | undefined, spec: OpenApiSpec): string {
  if (!schema) return "any";
  if (schema.$ref) return getRefName(schema.$ref);
  if (schema.type === "array") {
    const items = schema.items;
    if (items?.$ref) return `${getRefName(items.$ref)}[]`;
    return `${items?.type ?? "any"}[]`;
  }
  if (schema.enum) return schema.enum.map(String).join(" | ");
  return schema.type ?? "object";
}

interface ParsedEndpoint {
  method: string;
  path: string;
  operation: OperationObject;
  tag: string;
}

function parseEndpoints(spec: OpenApiSpec): { tags: Map<string, { description?: string; endpoints: ParsedEndpoint[] }> } {
  const tags = new Map<string, { description?: string; endpoints: ParsedEndpoint[] }>();

  // Seed tags from spec.tags
  for (const t of spec.tags ?? []) {
    tags.set(t.name, { description: t.description, endpoints: [] });
  }

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
        const tag = operation.tags?.[0] ?? "Default";
        if (!tags.has(tag)) tags.set(tag, { description: undefined, endpoints: [] });
        tags.get(tag)!.endpoints.push({ method, path, operation, tag });
      }
    }
  }

  return { tags };
}

// ─── Schema renderer ─────────────────────────────────────────────────

function SchemaProperties({ schema, spec, depth = 0 }: { schema: SchemaObject; spec: OpenApiSpec; depth?: number }) {
  const t = useTranslations("console.apiDocs");
  const resolved = resolveSchema(schema, spec);
  if (!resolved?.properties) return null;

  const requiredSet = new Set(resolved.required ?? []);

  return (
    <div className={cn("space-y-0 divide-y divide-border/50", depth > 0 && "ml-4 border-l border-border/30 pl-3")}>
      {Object.entries(resolved.properties).map(([name, prop]) => {
        const propSchema = resolveSchema(prop, spec);
        const isRequired = requiredSet.has(name);
        const typeName = getSchemaTypeName(prop, spec);
        const isObject = propSchema?.type === "object" && propSchema.properties;
        const isArrayOfObject = propSchema?.type === "array" && propSchema.items && (resolveSchema(propSchema.items, spec)?.properties);

        return (
          <div key={name} className="py-2 first:pt-0 last:pb-0">
            <div className="flex items-start gap-2">
              <code className="text-[13px] text-cream/85 font-mono shrink-0">{name}</code>
              {isRequired && (
                <span className="text-[9px] font-semibold uppercase tracking-wider text-terra/80 mt-0.5">{t("required")}</span>
              )}
              <span className="text-[11px] text-cream/45 font-mono mt-0.5">{typeName}</span>
              {propSchema?.format && (
                <span className="text-[10px] text-cream/35 font-mono mt-0.5">({propSchema.format})</span>
              )}
            </div>
            {(propSchema?.description || propSchema?.enum || propSchema?.example !== undefined || propSchema?.default !== undefined || propSchema?.minimum !== undefined || propSchema?.maximum !== undefined) && (
              <div className="mt-0.5 space-y-0.5">
                {propSchema?.description && (
                  <p className="text-[11px] text-cream/45 leading-relaxed">{propSchema.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {propSchema?.enum && (
                    <span className="text-[10px] text-cream/45">
                      enum: {propSchema.enum.map((v) => <code key={String(v)} className="text-cream/60 bg-secondary/50 px-1 py-px rounded mx-0.5">{String(v)}</code>)}
                    </span>
                  )}
                  {propSchema?.default !== undefined && (
                    <span className="text-[10px] text-cream/45">default: <code className="text-cream/60">{JSON.stringify(propSchema.default)}</code></span>
                  )}
                  {propSchema?.example !== undefined && (
                    <span className="text-[10px] text-cream/45">example: <code className="text-cream/60">{JSON.stringify(propSchema.example)}</code></span>
                  )}
                  {(propSchema?.minimum !== undefined || propSchema?.maximum !== undefined) && (
                    <span className="text-[10px] text-cream/45">
                      range: {propSchema?.minimum ?? "∞"}–{propSchema?.maximum ?? "∞"}
                    </span>
                  )}
                </div>
              </div>
            )}
            {isObject && depth < 3 && <SchemaProperties schema={propSchema!} spec={spec} depth={depth + 1} />}
            {isArrayOfObject && depth < 3 && <SchemaProperties schema={resolveSchema(propSchema!.items!, spec)!} spec={spec} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Endpoint card ────────────────────────────────────────────────────

function EndpointCard({ endpoint, spec }: { endpoint: ParsedEndpoint; spec: OpenApiSpec }) {
  const t = useTranslations("console.apiDocs");
  const [expanded, setExpanded] = useState(false);
  const { method, path, operation } = endpoint;
  const style = getMethodStyle(method);

  const hasParams = (operation.parameters?.length ?? 0) > 0;
  const hasBody = !!operation.requestBody;
  const responses = Object.entries(operation.responses ?? {});
  const hasDetail = hasParams || hasBody || responses.length > 0;

  return (
    <div className={cn("border rounded-lg overflow-hidden transition-colors", style.border, expanded ? "bg-card" : "bg-card/50 hover:bg-card")}>
      {/* Header row */}
      <button
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={cn("w-full flex items-center gap-3 px-3 py-2.5 text-left", hasDetail && "cursor-pointer")}
      >
        <span className={cn("text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md shrink-0 w-14 text-center", style.bg, style.text)}>
          {method === "delete" ? "DEL" : method.toUpperCase()}
        </span>
        <code className="text-[13px] text-cream/85 font-mono truncate">{path}</code>
        {operation.deprecated && (
          <span className="text-[9px] font-semibold uppercase tracking-wider text-sodium/70 bg-sodium/10 px-1.5 py-0.5 rounded shrink-0">{t("deprecated")}</span>
        )}
        <span className="text-[12px] text-cream/45 truncate ml-auto mr-2">{operation.summary}</span>
        {hasDetail && (
          expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-cream/45 shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-cream/45 shrink-0" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && hasDetail && (
        <div className="border-t border-border/50 px-4 py-3 space-y-4">
          {operation.description && (
            <p className="text-[12px] text-cream/60 leading-relaxed">{operation.description}</p>
          )}

          {/* Parameters */}
          {hasParams && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-cream/45 mb-2">{t("parameters")}</h4>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-secondary/30">
                      <th className="text-left px-3 py-1.5 text-cream/45 font-medium">{t("name")}</th>
                      <th className="text-left px-3 py-1.5 text-cream/45 font-medium">{t("in")}</th>
                      <th className="text-left px-3 py-1.5 text-cream/45 font-medium">{t("type")}</th>
                      <th className="text-left px-3 py-1.5 text-cream/45 font-medium">{t("description")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {operation.parameters!.map((param) => (
                      <tr key={`${param.in}-${param.name}`}>
                        <td className="px-3 py-1.5">
                          <code className="text-cream/85 font-mono">{param.name}</code>
                          {param.required && <span className="text-terra ml-1">*</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded font-medium",
                            param.in === "path" ? "bg-sodium/10 text-cream/65" :
                            param.in === "query" ? "bg-cyan-500/10 text-cyan-400" :
                            "bg-cream/[0.04] text-cream/60"
                          )}>{param.in}</span>
                        </td>
                        <td className="px-3 py-1.5 text-cream/45 font-mono">
                          {getSchemaTypeName(param.schema, spec)}
                          {param.schema?.enum && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {param.schema.enum.map((v) => (
                                <code key={String(v)} className="text-[10px] bg-secondary/60 px-1 py-px rounded text-cream/60">{String(v)}</code>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-cream/45">{param.description ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Request Body */}
          {hasBody && (() => {
            const jsonContent = operation.requestBody!.content?.["application/json"];
            const bodySchema = jsonContent?.schema ? resolveSchema(jsonContent.schema, spec) : undefined;
            const examples = jsonContent?.examples;
            return (
              <div>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-cream/45 mb-2">
                  {t("requestBody")}
                  {operation.requestBody!.required && <span className="text-terra/80 ml-1">{t("required")}</span>}
                </h4>
                {operation.requestBody!.description && (
                  <p className="text-[11px] text-cream/45 mb-2">{operation.requestBody!.description}</p>
                )}
                {bodySchema && (
                  <div className="rounded-md border border-border bg-secondary/20 p-3">
                    {bodySchema.$ref && (
                      <div className="text-[10px] text-cream/45 mb-2 font-mono">{getRefName(bodySchema.$ref)}</div>
                    )}
                    <SchemaProperties schema={bodySchema} spec={spec} />
                  </div>
                )}
                {examples && Object.keys(examples).length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {Object.entries(examples).map(([key, ex]) => (
                      <details key={key} className="group">
                        <summary className="text-[11px] text-cream/45 cursor-pointer hover:text-cream/75 flex items-center gap-1">
                          <ChevronRight className="h-3 w-3 group-open:rotate-90 transition-transform" />
                          {t("exampleLabel", { name: ex.summary ?? key })}
                        </summary>
                        <pre className="mt-1 text-[11px] text-cream/60 bg-secondary/30 rounded-md p-2 font-mono overflow-x-auto">
                          {JSON.stringify(ex.value, null, 2)}
                        </pre>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Responses */}
          {responses.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-cream/45 mb-2">{t("responses")}</h4>
              <div className="space-y-2">
                {responses.map(([code, resp]) => {
                  const isSuccess = code.startsWith("2");
                  const jsonContent = resp.content?.["application/json"];
                  const respSchema = jsonContent?.schema ? resolveSchema(jsonContent.schema, spec) : undefined;
                  return (
                    <div key={code} className="rounded-md border border-border overflow-hidden">
                      <div className={cn("flex items-center gap-2 px-3 py-1.5", isSuccess ? "bg-sodium/5" : "bg-secondary/20")}>
                        <span className={cn(
                          "text-[12px] font-bold font-mono",
                          isSuccess ? "text-sodium" : code.startsWith("4") ? "text-sodium" : "text-terra"
                        )}>{code}</span>
                        <span className="text-[11px] text-cream/45">{resp.description}</span>
                      </div>
                      {respSchema?.properties && (
                        <div className="px-3 py-2 border-t border-border/50">
                          <SchemaProperties schema={respSchema} spec={spec} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Framework instructions ──────────────────────────────────────────

const FRAMEWORK_INSTRUCTIONS: Record<string, { pkg: string; snippet: string }> = {
  express: {
    pkg: "swagger-jsdoc swagger-ui-express",
    snippet: `import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'API', version: '1.0.0' },
  },
  apis: ['./src/routes/*.ts'],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));`,
  },
  fastify: {
    pkg: "@fastify/swagger @fastify/swagger-ui",
    snippet: `await fastify.register(import('@fastify/swagger'), {
  openapi: { info: { title: 'API', version: '1.0.0' } },
});
await fastify.register(import('@fastify/swagger-ui'), {
  routePrefix: '/documentation',
});`,
  },
  nestjs: {
    pkg: "@nestjs/swagger",
    snippet: `const config = new DocumentBuilder()
  .setTitle('API').setVersion('1.0').build();
const doc = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api', app, doc);`,
  },
  hono: {
    pkg: "@hono/zod-openapi",
    snippet: `const app = new OpenAPIHono();
app.doc('/doc', {
  openapi: '3.0.0',
  info: { title: 'API', version: '1.0.0' },
});`,
  },
  fastapi: {
    pkg: "(built-in)",
    snippet: `# FastAPI generates OpenAPI automatically!
# Visit /docs for Swagger UI or /openapi.json for the spec.
from fastapi import FastAPI
app = FastAPI(title="API", version="1.0.0")`,
  },
  flask: {
    pkg: "flask-smorest",
    snippet: `app.config["API_TITLE"] = "API"
app.config["OPENAPI_VERSION"] = "3.0.0"
api = Api(app)`,
  },
  django: { pkg: "drf-spectacular", snippet: `SPECTACULAR_SETTINGS = { 'TITLE': 'API', 'VERSION': '1.0.0' }` },
  "asp.net": { pkg: "Swashbuckle.AspNetCore", snippet: `builder.Services.AddSwaggerGen();\napp.UseSwagger();` },
  spring: { pkg: "springdoc-openapi", snippet: `<!-- springdoc-openapi-starter-webmvc-ui -->` },
  koa: { pkg: "koa-swagger-decorator", snippet: `router.swagger({ title: 'API', version: '1.0.0' });` },
  go: { pkg: "swaggo/swag", snippet: `// go install github.com/swaggo/swag/cmd/swag@latest\n// swag init` },
};

function getFrameworkInstructions(framework: string): { pkg: string; snippet: string } | null {
  const key = framework.toLowerCase();
  for (const [k, v] of Object.entries(FRAMEWORK_INSTRUCTIONS)) {
    if (key.includes(k)) return v;
  }
  return null;
}

// ─── Manual setup instructions (shared between exhausted + default states) ──

function ManualSetupInstructions({ instructions }: { instructions: { pkg: string; snippet: string } | null }) {
  const t = useTranslations("console.apiDocs");
  if (instructions) {
    return (
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs text-cream/60">{t("installLabel")} <code className="text-blue-400">{instructions.pkg}</code></span>
        </div>
        <pre className="p-3 text-[11px] text-cream/75 overflow-x-auto leading-relaxed font-mono">{instructions.snippet}</pre>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <p className="text-xs text-cream/60 mb-2">{t("manualSetupHint")}</p>
      <div className="flex flex-wrap gap-1.5">
        {["/openapi.json", "/swagger.json", "/api-docs", "/doc"].map((p) => (
          <code key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-cream/75 font-mono">{p}</code>
        ))}
      </div>
      <a href="https://swagger.io/specification/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2">
        {t("openApiSpec")} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export function ApiDocsPreview({ app, devDomain, serverDomain, isPreviewActive }: ApiDocsPreviewProps) {
  const t = useTranslations("console.apiDocs");
  const { spec, specPath, isLoading, isFetching, healStatus, healAttempts, maxHealAttempts, refetch } = useOpenApiSpec(
    app.directory,
    serverDomain,
    { enabled: isPreviewActive }
  );
  const [copied, setCopied] = useState<string | null>(null);

  const parsedSpec = useMemo(() => {
    if (!spec) return null;
    return parseEndpoints(spec as unknown as OpenApiSpec);
  }, [spec]);

  const handleCopy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const baseUrl = `https://${devDomain}`;
  const typedSpec = spec as unknown as OpenApiSpec | null;

  // Loading
  if (isPreviewActive && isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 text-blue-500 animate-spin mx-auto mb-3" />
          <p className="text-sm text-cream/60">{t("scanning")}</p>
          <p className="text-xs text-cream/45 mt-1">{t("scanningHint")}</p>
        </div>
      </div>
    );
  }

  // Spec found — custom rendered docs
  if (typedSpec && parsedSpec) {
    const info = typedSpec.info;
    const tagCount = parsedSpec.tags.size;
    const endpointCount = Array.from(parsedSpec.tags.values()).reduce((sum, t) => sum + t.endpoints.length, 0);

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50 shrink-0">
          <BookOpen className="h-3.5 w-3.5 text-sodium" />
          <span className="text-xs text-cream/60">
            <code className="text-sodium">{specPath}</code>
          </span>
          <span className="text-[10px] text-cream/35 ml-1">{t("endpoints", { count: endpointCount })}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-auto text-cream/60 hover:text-cream"
            onClick={() => refetch()}
            title={t("refreshSpec")}
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          </Button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-5 space-y-6">
            {/* API header */}
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h2 className="text-lg font-semibold text-cream">{info?.title ?? app.displayName ?? app.name}</h2>
                {info?.version && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-secondary text-cream/60 border border-border">
                    v{info.version}
                  </span>
                )}
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-sodium/10 text-sodium border border-sodium/20">
                  OpenAPI {typedSpec.openapi ?? typedSpec.swagger}
                </span>
              </div>
              {info?.description && (
                <p className="text-[13px] text-cream/60 leading-relaxed">{info.description}</p>
              )}
              {/* Base URL pill */}
              <div className="flex items-center gap-2 mt-3">
                <div className="flex items-center gap-2 bg-secondary/40 border border-border rounded-lg px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-cream/45 font-semibold">{t("base")}</span>
                  <code className="text-[12px] text-cream/75 font-mono">{baseUrl}</code>
                  <button
                    onClick={() => handleCopy(baseUrl)}
                    className="text-cream/45 hover:text-cream/75 transition-colors ml-1"
                  >
                    {copied === baseUrl ? <Check className="h-3 w-3 text-sodium" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Endpoint groups */}
            {Array.from(parsedSpec.tags.entries()).map(([tagName, tag]) => (
              <div key={tagName}>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-cream/85">{tagName}</h3>
                  <span className="text-[10px] text-cream/35">{tag.endpoints.length}</span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                {tag.description && (
                  <p className="text-[11px] text-cream/45 mb-2 -mt-1">{tag.description}</p>
                )}
                <div className="space-y-2">
                  {tag.endpoints.map((ep) => (
                    <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} spec={typedSpec} />
                  ))}
                </div>
              </div>
            ))}

            {/* Models section */}
            {typedSpec.components?.schemas && Object.keys(typedSpec.components.schemas).length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-cream/85">{t("models")}</h3>
                  <span className="text-[10px] text-cream/35">{Object.keys(typedSpec.components.schemas).length}</span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                <div className="space-y-2">
                  {Object.entries(typedSpec.components.schemas).map(([name, schema]) => (
                    <ModelCard key={name} name={name} schema={schema} spec={typedSpec} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // No spec / preview not active — fallback
  const instructions = getFrameworkInstructions(app.framework);

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
            <Code2 className="h-7 w-7 text-blue-400" />
          </div>
          <h3 className="text-base font-medium text-cream/85 mb-1">{app.displayName || app.name}</h3>
          <div className="flex items-center justify-center gap-2">
            {app.framework !== "unknown" && (
              <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                {app.framework}
              </span>
            )}
            <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full bg-cream/[0.04] text-cream/60 border border-cream/[0.08]/20">
              {t("backend")}
            </span>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-cream/45 mb-1">{t("baseUrl")}</p>
              <code className="text-sm text-cream/75 font-mono truncate block">{baseUrl}</code>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-cream/60 hover:text-cream" onClick={() => handleCopy(baseUrl)}>
              {copied === baseUrl ? <Check className="h-3.5 w-3.5 text-sodium" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        {!isPreviewActive ? (
          <p className="text-xs text-cream/45 text-center">{t("startServerHint")}</p>
        ) : healStatus === "healing" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2">
              <Spinner size="sm" color="primary" />
              <p className="text-xs text-blue-400">{t("healing")}</p>
            </div>
            <p className="text-[11px] text-cream/45 text-center">
              {t("healingAttempts", { current: healAttempts, max: maxHealAttempts })}
            </p>
          </div>
        ) : healStatus === "exhausted" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2">
              <AlertTriangle className="h-4 w-4 text-sodium" />
              <p className="text-xs text-sodium">{t("exhausted")}</p>
            </div>
            <p className="text-[11px] text-cream/45 text-center">{t("exhaustedHint")}</p>
            <ManualSetupInstructions instructions={instructions} />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-cream/60 text-center">{t("noSpec")}</p>
            <ManualSetupInstructions instructions={instructions} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Model card ──────────────────────────────────────────────────────

function ModelCard({ name, schema, spec }: { name: string; schema: SchemaObject; spec: OpenApiSpec }) {
  const t = useTranslations("console.apiDocs");
  const [expanded, setExpanded] = useState(false);
  const resolved = resolveSchema(schema, spec);
  const propCount = resolved?.properties ? Object.keys(resolved.properties).length : 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card/50 hover:bg-card transition-colors">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
        <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-sodium/10 text-cream/65 border border-sodium/20 shrink-0">
          {t("model")}
        </span>
        <code className="text-[13px] text-cream/85 font-mono">{name}</code>
        <span className="text-[11px] text-cream/35 ml-auto mr-2">{t("properties", { count: propCount })}</span>
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-cream/45 shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-cream/45 shrink-0" />}
      </button>
      {expanded && resolved?.properties && (
        <div className="border-t border-border/50 px-4 py-3">
          <SchemaProperties schema={resolved} spec={spec} />
        </div>
      )}
    </div>
  );
}
