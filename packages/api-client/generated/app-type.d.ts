declare const app: import("hono/hono-base").HonoBase<{}, ((({
    "/health": {
        $get: {
            input: {};
            output: {
                status: string;
                timestamp: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/health/deep": {
        $get: {
            input: {};
            output: {
                status: string;
                db: {
                    readonly ok: boolean;
                    readonly latencyMs: number;
                    readonly code?: import("./services/diag.service").DbErrorCode | undefined;
                    readonly message?: string | undefined;
                };
                timestamp: string;
            };
            outputFormat: "json";
            status: 200 | 503;
        };
    };
} & {
    "/health/ready": {
        $get: {
            input: {};
            output: {
                status: string;
                db: {
                    readonly ok: boolean;
                    readonly latencyMs: number;
                    readonly code?: import("./services/diag.service").DbErrorCode | undefined;
                    readonly message?: string | undefined;
                };
                timestamp: string;
            };
            outputFormat: "json";
            status: 200 | 503;
        };
    };
}) | import("hono/types").MergeSchemaPath<{
    "/apple": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                code: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/google": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                code: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/github": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                code: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/session": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/session/establish": {
        $get: {
            input: {};
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
} & {
    "/start": {
        $get: {
            input: {};
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/callback": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
} & {
    "/poll": {
        $get: {
            input: {};
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/vps-auth-data": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/vps-auth-data": {
        $get: {
            input: {};
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/connect-complete": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/connect-poll": {
        $get: {
            input: {};
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/auth/native">) & {
    "/api/auth/*": {
        $post: {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        } | {
            input: {};
            output: Promise<void>;
            outputFormat: "json";
            status: import("hono/utils/http-status").StatusCode;
        } | {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        } | {
            input: {};
            output: Promise<void>;
            outputFormat: "json";
            status: import("hono/utils/http-status").StatusCode;
        } | {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
}) | import("hono/types").MergeSchemaPath<{
    "/events": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
}, "/api/servers"> | import("hono/types").MergeSchemaPath<{
    "/register-key": {
        $post: {
            input: {
                json: {
                    fingerprint: string;
                    publicKey: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    fingerprint: string;
                    publicKey: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    fingerprint: string;
                    publicKey: string;
                };
            };
            output: {
                success: true;
                fingerprint: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    fingerprint: string;
                    publicKey: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/public-key": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets": {
        $post: {
            input: {
                json: {
                    name: string;
                    iv: string;
                    maskedValue: string;
                    encryptedKey: string;
                    encryptedData: string;
                    x25519EphPub?: string | undefined;
                    allowedDestinations?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    name: string;
                    iv: string;
                    maskedValue: string;
                    encryptedKey: string;
                    encryptedData: string;
                    x25519EphPub?: string | undefined;
                    allowedDestinations?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    name: string;
                    iv: string;
                    maskedValue: string;
                    encryptedKey: string;
                    encryptedData: string;
                    x25519EphPub?: string | undefined;
                    allowedDestinations?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                name: string;
                maskedValue: string;
                createdAt: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets/:name": {
        $put: {
            input: {
                json: {
                    name: string;
                    iv: string;
                    maskedValue: string;
                    encryptedKey: string;
                    encryptedData: string;
                    x25519EphPub?: string | undefined;
                    allowedDestinations?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    name: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets/:name": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    name: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    name: string;
                };
            };
            output: {
                success: true;
                deleted: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/secrets/sync": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/git-token": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets-mode": {
        $put: {
            input: {
                json: {
                    mode: "platform_managed" | "self_managed";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    mode: "platform_managed" | "self_managed";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                mode: "platform_managed" | "self_managed";
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/secrets": {
        $delete: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/servers"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema | import("hono/types").MergeSchemaPath<{
    "/commands": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/commands/:id/claim": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/commands/:id/complete": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/entitlement/current": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: null;
            outputFormat: "body";
            status: 204;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: null;
            outputFormat: "body";
            status: 304;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                seq: number;
                jws: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/agent-manifest/current": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: null;
            outputFormat: "body";
            status: 204;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: null;
            outputFormat: "body";
            status: 304;
        };
    };
} & {
    "/:id/agent-packages/:component/:semver": {
        $get: {
            input: {
                param: {
                    id: string;
                } & {
                    component: string;
                } & {
                    semver: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    component: string;
                } & {
                    semver: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    component: string;
                } & {
                    semver: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    component: string;
                } & {
                    semver: string;
                };
            };
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    component: string;
                } & {
                    semver: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/agent-report": {
        $post: {
            input: {
                json: {
                    appliedVersion: number;
                    autoUpdateEffective: boolean;
                    installedVersions: Record<string, string>;
                    lastInstallOutcome: "success" | "failed" | "partial" | "rolled_back" | "pending_approval";
                    health?: unknown;
                    pendingUpdateVersion?: number | null | undefined;
                    lastInstallError?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/agent-ping": {
        $post: {
            input: {
                json: {
                    autoUpdateEffective: boolean;
                    agentVersion: string;
                    manifestVersion: number;
                    installedVersions: Record<string, string>;
                    systemdHealth: Record<string, "unknown" | "active" | "failed" | "activating" | "inactive">;
                    capabilities: string[];
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    autoUpdateEffective: boolean;
                    agentVersion: string;
                    manifestVersion: number;
                    installedVersions: Record<string, string>;
                    systemdHealth: Record<string, "unknown" | "active" | "failed" | "activating" | "inactive">;
                    capabilities: string[];
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    autoUpdateEffective: boolean;
                    agentVersion: string;
                    manifestVersion: number;
                    installedVersions: Record<string, string>;
                    systemdHealth: Record<string, "unknown" | "active" | "failed" | "activating" | "inactive">;
                    capabilities: string[];
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                desiredVersion: number | null;
                pingIntervalSeconds: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    autoUpdateEffective: boolean;
                    agentVersion: string;
                    manifestVersion: number;
                    installedVersions: Record<string, string>;
                    systemdHealth: Record<string, "unknown" | "active" | "failed" | "activating" | "inactive">;
                    capabilities: string[];
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/update": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: 202;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/agent-update-mode": {
        $post: {
            input: {
                json: {
                    mode: "auto" | "manual";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    mode: "auto" | "manual";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                status: string;
                commandId: string;
                expiresAt: string;
                mode: "auto" | "manual";
            };
            outputFormat: "json";
            status: 202;
        } | {
            input: {
                json: {
                    mode: "auto" | "manual";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/block-migration/:snapshotId/chunk-complete": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                nextUploadUrl: string | null;
                done: boolean;
                chunksUploaded: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/chunks-complete": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                chunksUploaded: number;
                done: boolean;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/upload-urls": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                urls: {
                    chunkIndex: number;
                    uploadUrl: string;
                    r2ObjectKey: string;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/download-urls": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                urls: {
                    chunkIndex: number;
                    downloadUrl: string;
                    expectedSha256: string;
                    expectedSize: number;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/download-url": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                downloadUrl: string;
                expectedSha256: string;
                expectedSize: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/chunks-downloaded": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                chunksDownloaded: number;
                done: boolean;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/seal": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                ok: boolean;
                error?: string | undefined;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/block-migration/:snapshotId/verify": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                ok: boolean;
                error?: string | undefined;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/migration-status": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                active: boolean;
                migration: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/migration-history": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/migrations": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/migrations/:snapshotId": {
        $get: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/migrations/:snapshotId/events": {
        $get: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/migrations/:snapshotId/cancel": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                ok: true;
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/migration-estimate": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                estimate: any;
                source: any;
                target: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/status": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/status/:serverId": {
        $get: {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/certificate-quota": {
        $get: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                baseDomain: string;
                used: number;
                limit: number;
                available: number;
                canIssueCertificate: boolean;
                percentUsed: number;
                resetAt: string;
                resetIn: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/refresh": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                serverId: string;
                cloudServerId: string;
                ipAddress: string;
                domain: string;
                status: string;
                sshEnabled: boolean;
                terminalEnabled: boolean;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/": {
        $get: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                servers: {
                    serverId: string;
                    cloudServerId: string;
                    ipAddress: string;
                    domain: string;
                    status: string;
                    sshEnabled: boolean;
                    terminalEnabled: boolean;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/": {
        $post: {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                message: string;
                server: {
                    id: string;
                    ipAddress: string;
                    domain: string;
                    state: string;
                    serverPlan: string;
                    sshEnabled: false;
                    terminalEnabled: true;
                };
                hibernation: {
                    waking: true;
                    note: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                message: string;
                server: {
                    id: string;
                    ipAddress: string;
                    domain: string;
                    state: "error" | "creating" | "provisioning" | "running" | "pool_ready" | "pending_deletion" | "destroying" | "hibernated" | "upgrading" | "downgrading" | "frozen" | "pool_assigned";
                    serverPlan: string;
                    sshEnabled: false;
                    terminalEnabled: true;
                };
                access: {
                    terminal: {
                        method: string;
                        message: string;
                    };
                };
                limits: {
                    workspaceSize: string;
                    hibernation: string;
                    security: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                message: string;
                server: any;
                upgrade: {
                    fromPlan: string;
                    toPlan: import("./engines").ServerPlan;
                    workspacePreserved: true;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                message: string;
                server: {
                    id: string;
                    ipAddress: string;
                    domain: string;
                    status: string;
                    sshEnabled: false;
                    terminalEnabled: boolean;
                    name: string;
                    serverPlan: string;
                    cloudProvider: import("./engines").CloudProviderType;
                };
                poolInfo: {
                    instant: boolean;
                    serverPlan: string;
                    provider: import("./engines").CloudProviderType;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                message: string;
                server: {
                    id: string;
                    cloudServerId: string;
                    ipAddress: string;
                    domain: string;
                    status: "error" | "creating" | "provisioning" | "running" | "pool_ready" | "pending_deletion" | "destroying" | "hibernated" | "upgrading" | "downgrading" | "frozen" | "pool_assigned";
                    sshEnabled: false;
                    terminalEnabled: true;
                    name: string;
                    serverPlan: string;
                    ramGb: number;
                };
                credentials: {
                    aiProxyToken: string;
                    warning: string;
                };
                access: {
                    terminal: {
                        method: string;
                        message: string;
                        note: string;
                    };
                    ssh: {
                        method: string;
                        message: string;
                        note: string;
                    };
                };
                poolInfo: {
                    instant: false;
                    provider: import("./engines").CloudProviderType;
                    usedFallback: boolean;
                    note: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    product?: "cloud_platform" | "shield_proxy" | undefined;
                    plan?: "free" | "hobby" | "pro" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/wake": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                message: string;
                serverId: string;
                state: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/tiers": {
        $get: {
            input: {};
            output: {
                tiers: {
                    id: string;
                    name: string;
                    price: number;
                    annualPrice: number;
                    annualMonthlyRate: number;
                    description: string;
                    features: string[] | undefined;
                    capacity: string;
                    engine: string;
                    product: import("./engines").Product;
                    plan: import("./engines").ServerPlan;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/tier-options": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                currentTier: {
                    id: string;
                    name: string;
                    price: number;
                };
                currentInterval: string;
                currentRegion: import("./engines").UnifiedRegion;
                currentProvider: import("./providers").CloudProviderType;
                pendingDowngrade: any;
                pendingUpgrade: any;
                options: {
                    tier: {
                        id: string;
                        name: string;
                        price: number;
                        annualPrice: number;
                        annualMonthlyEquivalent: number;
                        description: string;
                        capacity: string;
                        features: string[];
                        engine: "byos" | "ephemeral" | "persistent" | null;
                    };
                    type: "upgrade" | "downgrade" | "same";
                    priceChange: number;
                    instant: {
                        provider: import("./engines").CloudProviderType;
                        serverType: string;
                        ramGb: number;
                        downtimeSeconds: number;
                    };
                    migrate: {
                        provider: import("./engines").CloudProviderType;
                        serverType: string;
                        ramGb: number;
                        downtimeSeconds: number;
                        differentProvider: boolean;
                    };
                    migrationAvailable: boolean;
                    migrationBenefit: string | null;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/change-tier": {
        $post: {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                pending: true;
                message: string;
                billing: {
                    success: true;
                    changeType: "upgrade" | "downgrade" | "same";
                    amountCharged: number | undefined;
                    nextBillingAmount: number;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                billingFailed: true;
                infrastructureUnchanged: true;
            };
            outputFormat: "json";
            status: 402 | 500;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                scheduled: true;
                message: string;
                effectiveDate: string;
                pendingDowngrade: {
                    plan: "hobby" | "pro";
                    interval: "monthly" | "annual";
                    effectiveDate: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                    forceMigration?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/cancel-downgrade": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/rebuild": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                message: string;
                success: boolean;
                credentials: {
                    warning: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/rollback": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                success: boolean;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/alert": {
        $post: {
            input: {
                json: {
                    serverId: string;
                    status: "good" | "struggling";
                    availableMemoryMB?: number | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    serverId: string;
                    status: "good" | "struggling";
                    availableMemoryMB?: number | undefined;
                };
            };
            output: {
                message: string;
                serverId: string;
                status: "good" | "struggling";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    serverId: string;
                    status: "good" | "struggling";
                    availableMemoryMB?: number | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/kill-processes": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                message: string;
                killedPorts: number[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/remount-volume": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                success: boolean;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id/retry": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
                state: string;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/settings": {
        $patch: {
            input: {
                json: {
                    preferredView?: "terminal" | "workbench" | undefined;
                    preferredSession?: "opencode" | "main" | "claude" | "codex" | "cursor" | "claw" | "grok" | undefined;
                    preferredApp?: string | null | undefined;
                    snapshotDisabled?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                message: string;
                settings: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/preferences": {
        $patch: {
            input: {
                json: {
                    preferredView?: "terminal" | "workbench" | undefined;
                    preferredSession?: "opencode" | "main" | "claude" | "codex" | "cursor" | "claw" | "grok" | undefined;
                    preferredApp?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    preferredView?: "terminal" | "workbench" | undefined;
                    preferredSession?: "opencode" | "main" | "claude" | "codex" | "cursor" | "claw" | "grok" | undefined;
                    preferredApp?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    preferredView?: "terminal" | "workbench" | undefined;
                    preferredSession?: "opencode" | "main" | "claude" | "codex" | "cursor" | "claw" | "grok" | undefined;
                    preferredApp?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                message: string;
                preferences: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/workspace/:sandboxId": {
        $get: {
            input: {
                param: {
                    id: string;
                } & {
                    sandboxId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/workspace/:sandboxId": {
        $put: {
            input: {
                json: {
                    config: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    };
                    templateId?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    config: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    };
                    templateId?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    config: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    };
                    templateId?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/workspace-templates": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/workspace-templates": {
        $post: {
            input: {
                json: {
                    name: string;
                    config: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    };
                    description?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    name: string;
                    config: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    };
                    description?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/workspace-templates/:templateId": {
        $put: {
            input: {
                json: {
                    name?: string | undefined;
                    description?: string | null | undefined;
                    config?: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    } | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    description?: string | null | undefined;
                    config?: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    } | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    description?: string | null | undefined;
                    config?: {
                        version: 1;
                        revision: number;
                        basedOnPresetId: string | null;
                        contexts: Record<string, {
                            orderedTabs: {
                                enabled: boolean;
                                extensionId: string;
                                tabId: string;
                            }[];
                        }>;
                    } | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/workspace-templates/:templateId": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    templateId: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/groups": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups": {
        $post: {
            input: {
                json: {
                    name: string;
                    sandboxId: string;
                    iconKey: string;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    name: string;
                    sandboxId: string;
                    iconKey: string;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    name: string;
                    sandboxId: string;
                    iconKey: string;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    name: string;
                    sandboxId: string;
                    iconKey: string;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                message: string;
            };
            outputFormat: "json";
            status: 201;
        };
    };
} & {
    "/:id/groups/:gid": {
        $patch: {
            input: {
                json: {
                    name?: string | undefined;
                    iconKey?: string | undefined;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    iconKey?: string | undefined;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    iconKey?: string | undefined;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    name?: string | undefined;
                    iconKey?: string | undefined;
                    routeRole?: "db-default" | "deploy-default" | "cloudflare-default" | "payments-default" | "git-default" | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid": {
        $delete: {
            input: {
                json?: {
                    reason?: string | undefined;
                } | undefined;
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json?: {
                    reason?: string | undefined;
                } | undefined;
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json?: {
                    reason?: string | undefined;
                } | undefined;
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections": {
        $post: {
            input: {
                json: {
                    displayName: string;
                    adapterType: "mcp" | "http" | "oauth" | "native_api";
                    providerKind: "github" | "gitlab" | "vercel" | "custom" | "cloudflare_workers" | "supabase" | "neon" | "planetscale" | "stripe" | "turso" | "bitbucket";
                    oauthConnectionRef?: string | undefined;
                    mcpUrl?: string | undefined;
                    mcpTransport?: "stdio" | "sse" | "streamable-http" | undefined;
                    oauthProvider?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    displayName: string;
                    adapterType: "mcp" | "http" | "oauth" | "native_api";
                    providerKind: "github" | "gitlab" | "vercel" | "custom" | "cloudflare_workers" | "supabase" | "neon" | "planetscale" | "stripe" | "turso" | "bitbucket";
                    oauthConnectionRef?: string | undefined;
                    mcpUrl?: string | undefined;
                    mcpTransport?: "stdio" | "sse" | "streamable-http" | undefined;
                    oauthProvider?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    displayName: string;
                    adapterType: "mcp" | "http" | "oauth" | "native_api";
                    providerKind: "github" | "gitlab" | "vercel" | "custom" | "cloudflare_workers" | "supabase" | "neon" | "planetscale" | "stripe" | "turso" | "bitbucket";
                    oauthConnectionRef?: string | undefined;
                    mcpUrl?: string | undefined;
                    mcpTransport?: "stdio" | "sse" | "streamable-http" | undefined;
                    oauthProvider?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                message: string;
            };
            outputFormat: "json";
            status: 201;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/set-default": {
        $post: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/enable-agent": {
        $post: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/disable-agent": {
        $post: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/discover": {
        $post: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/wire-git": {
        $post: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                };
            };
            output: {
                wired: string[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/available-providers": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                providers: {
                    id: string;
                    label: string;
                    roles: string[];
                    configured: boolean;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/mcp-connections": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/integrations": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                sandboxId: string;
                state: {
                    deployProviders: string[];
                    dataProviders: string[];
                    gitProviders: string[];
                    cloudflareProviders: string[];
                    paymentProviders: string[];
                    hasLinkedRepo: boolean;
                    hasDeployConfig: boolean;
                    hasDatabase: boolean;
                    hasMigrations: boolean;
                };
                connections: {
                    deploy: {
                        providerKind: string;
                        displayName: string;
                        status: import("@ellul.ai/types").ConnectionHealth;
                        isDefault: boolean;
                    }[];
                    data: {
                        providerKind: string;
                        displayName: string;
                        status: import("@ellul.ai/types").ConnectionHealth;
                        isDefault: boolean;
                    }[];
                    git: {
                        providerKind: string;
                        displayName: string;
                        status: import("@ellul.ai/types").ConnectionHealth;
                        isDefault: boolean;
                    }[];
                    cloudflare: {
                        providerKind: string;
                        displayName: string;
                        status: import("@ellul.ai/types").ConnectionHealth;
                        isDefault: boolean;
                    }[];
                    payments: {
                        providerKind: string;
                        displayName: string;
                        status: import("@ellul.ai/types").ConnectionHealth;
                        isDefault: boolean;
                    }[];
                };
                computedAt: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/groups/:gid/connections/:cid/permissions": {
        $get: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/permissions/:tool": {
        $put: {
            input: {
                json: {
                    permission: "never" | "ask" | "allow_session" | "allow_always";
                    capability: string;
                    allowedEnvironments?: string[] | null | undefined;
                };
            } & {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                } & {
                    tool: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/groups/:gid/connections/:cid/permissions/:tool": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                } & {
                    tool: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                } & {
                    gid: string;
                } & {
                    cid: string;
                } & {
                    tool: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/custom-domain": {
        $post: {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                hostname: string;
                status: string;
                verification: {
                    type: "TXT" | "CNAME";
                    name: string;
                    value: string;
                    instructions: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    hostname: string;
                    termsAccepted: true;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                message: string;
            };
            outputFormat: "json";
            status: 502;
        };
    };
} & {
    "/:id/custom-domain": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/custom-domain/verify": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                status: "active" | "pending_validation" | "validating" | "issuing_cert" | "validation_failed" | "cert_failed" | "suspended";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                message: string;
            };
            outputFormat: "json";
            status: 502;
        };
    };
} & {
    "/:id/custom-domain": {
        $delete: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                status: null;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/backups": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                snapshotId: string;
                snapshotVersion: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/backups": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                backups: {
                    snapshotId: string;
                    backupName: string | null;
                    status: string;
                    volumeSizeBytes: string;
                    chunkCount: number;
                    merkleRootHash: string | null;
                    securityMode: string | null;
                    encryptionMode: "managed" | "sovereign";
                    createdAt: string;
                    backupExpiresAt: string | null;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/backups/:snapshotId": {
        $get: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                snapshotId: string;
                backupName: string | null;
                status: string;
                volumeSizeBytes: string;
                chunkCount: number;
                merkleRootHash: string | null;
                securityMode: string | null;
                encryptionMode: "managed" | "sovereign";
                createdAt: string;
                backupExpiresAt: string | null;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/backups/:snapshotId/restore": {
        $post: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                status: "running" | "awaiting_unlock";
                trustWarning?: string | undefined;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
} & {
    "/:id/backups/:snapshotId": {
        $delete: {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    snapshotId: string;
                } & {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/credentials": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/config": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/install": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: string;
            outputFormat: "body";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id": {
        $delete: {
            input: {
                json?: {} | undefined;
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json?: {} | undefined;
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json?: {} | undefined;
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/heartbeat-challenge": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                nonce: string;
                sessionKey: string;
                expiresIn: number;
                session: {
                    remainingMs: number;
                    warningActive: boolean;
                    softCapHit: boolean;
                    graceRemainingMs: number | null;
                    maxRenewalsPerDay: number;
                    renewalsRemaining: number;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/browser-heartbeat": {
        $post: {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                    viewport?: {
                        width: number;
                        height: number;
                    } | undefined;
                    hasFocus?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                    viewport?: {
                        width: number;
                        height: number;
                    } | undefined;
                    hasFocus?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                    viewport?: {
                        width: number;
                        height: number;
                    } | undefined;
                    hasFocus?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                    viewport?: {
                        width: number;
                        height: number;
                    } | undefined;
                    hasFocus?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                code: string;
                message: string;
                canRenew: boolean;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                    viewport?: {
                        width: number;
                        height: number;
                    } | undefined;
                    hasFocus?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                accepted: true;
                session: {
                    remainingMs: number;
                    warningActive: boolean;
                    softCapHit: boolean;
                    graceRemainingMs: number | null;
                    canRenew: boolean;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/renew-session": {
        $post: {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                code: string;
                message: string;
            };
            outputFormat: "json";
            status: 429;
        } | {
            input: {
                json: {
                    nonce: string;
                    signature: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                renewed: true;
                newSessionKey: string;
                session: {
                    remainingMs: number;
                    renewalsRemaining: number;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/:id/cli-heartbeat": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/provision-progress": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                success: true;
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
                step: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/heartbeat": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {};
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/">, "/api/servers"> | import("hono/types").MergeSchemaPath<{
    "/:id/security": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/security/tier": {
        $post: {
            input: {
                json: {
                    tier: "standard" | "web_locked" | "private_locked";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    tier: "standard" | "web_locked" | "private_locked";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                json: {
                    tier: "standard" | "web_locked" | "private_locked";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                currentTier: "standard" | "web_locked" | "private_locked";
                allowedTransitions: ("standard" | "web_locked" | "private_locked")[];
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    tier: "standard" | "web_locked" | "private_locked";
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                method: string;
                vpsEndpoint: string;
                authMethod: string;
                body: {
                    name: string;
                };
                instructions: string[];
                blocked: true;
                reason: string;
                currentTier: "standard" | "web_locked" | "private_locked";
                targetTier: "standard" | "web_locked" | "private_locked";
            } | {
                method: string;
                bridgeEndpoint: string;
                messageType: string;
                authMethod: string;
                instructions: string[];
                warning: string;
                blocked: true;
                reason: string;
                currentTier: "standard" | "web_locked" | "private_locked";
                targetTier: "standard" | "web_locked" | "private_locked";
            } | {
                error: string;
                blocked: true;
                reason: string;
                currentTier: "standard" | "web_locked" | "private_locked";
                targetTier: "standard" | "web_locked" | "private_locked";
            };
            outputFormat: "json";
            status: 403;
        };
    };
} & {
    "/:id/ssh-keys": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
                reason: string;
                hint: string;
            };
            outputFormat: "json";
            status: 403;
        };
    };
} & {
    "/:id/ssh-keys/:keyId": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    keyId: string;
                };
            };
            output: {
                error: string;
                reason: string;
                hint: string;
            };
            outputFormat: "json";
            status: 403;
        };
    };
} & {
    "/:id/vps-event": {
        $post: {
            input: {
                json: {
                    data: Record<string, unknown>;
                    event: "ssh_key_added" | "ssh_key_removed" | "volume_encrypted" | "volume_unlocked" | "settings_changed" | "tier_changed" | "passkey_registered" | "passkey_removed" | "heartbeat_key_reset";
                    timestamp: number;
                    nonce: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string | undefined;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    data: Record<string, unknown>;
                    event: "ssh_key_added" | "ssh_key_removed" | "volume_encrypted" | "volume_unlocked" | "settings_changed" | "tier_changed" | "passkey_registered" | "passkey_removed" | "heartbeat_key_reset";
                    timestamp: number;
                    nonce: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    data: Record<string, unknown>;
                    event: "ssh_key_added" | "ssh_key_removed" | "volume_encrypted" | "volume_unlocked" | "settings_changed" | "tier_changed" | "passkey_registered" | "passkey_removed" | "heartbeat_key_reset";
                    timestamp: number;
                    nonce: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    data: Record<string, unknown>;
                    event: "ssh_key_added" | "ssh_key_removed" | "volume_encrypted" | "volume_unlocked" | "settings_changed" | "tier_changed" | "passkey_registered" | "passkey_removed" | "heartbeat_key_reset";
                    timestamp: number;
                    nonce: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/servers"> | import("hono/types").MergeSchemaPath<{
    "/delete": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: any;
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
                message: string;
                deletionDate: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/cancel-deletion": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/status": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/nuke-user": {
        $post: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/account"> | import("hono/types").MergeSchemaPath<{
    "/preferences": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/preferences": {
        $patch: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/me"> | import("hono/types").MergeSchemaPath<{
    "/checkout": {
        $post: {
            input: {
                json: {
                    product: "cloud_platform" | "shield_proxy" | "byos_managed";
                    plan?: "hobby" | "pro" | undefined;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    product: "cloud_platform" | "shield_proxy" | "byos_managed";
                    plan?: "hobby" | "pro" | undefined;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    product: "cloud_platform" | "shield_proxy" | "byos_managed";
                    plan?: "hobby" | "pro" | undefined;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                url: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    product: "cloud_platform" | "shield_proxy" | "byos_managed";
                    plan?: "hobby" | "pro" | undefined;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/webhook": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                received: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/preview-change": {
        $post: {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                changeType: "upgrade" | "downgrade";
                immediateCharge?: number | undefined;
                effectiveDate?: string | undefined;
                newRecurringAmount: number;
                newInterval: import("./billing/stripe").BillingInterval;
                currentPeriodEnd: string;
                description: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    serverId: string;
                    newPlan: "hobby" | "pro";
                    newInterval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/portal": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                url: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/sandbox-addon": {
        $post: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/sandbox-addon": {
        $delete: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                removed: number;
                extraSandboxes: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/api/stripe"> | import("hono/types").MergeSchemaPath<{
    "/health": {
        $get: {
            input: {};
            output: {
                status: string;
                service: string;
                architecture: string;
                hasOpenCodeKey: boolean;
                hasDeepSeekKey: boolean;
                waterfallModels: any;
                discoveredFreeModels: number;
                lastDiscovery: string | null;
                timestamp: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/test": {
        $post: {
            input: {};
            output: {
                status: string;
                server: {
                    id: string;
                };
                quota: {
                    used: number;
                    remaining: number;
                    limit: number;
                };
                waterfall: {
                    models: any;
                    strategy: string;
                    discoveredCount: number;
                };
                providers: {
                    opencode: boolean;
                    deepseek: boolean;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/quota": {
        $get: {
            input: {};
            output: {
                quota: number;
                used: number;
                remaining: number;
                resetsIn: string;
                resetAt: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/chat/completions": {
        $post: {
            input: {};
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
} & {
    "/diag": {
        $get: {
            input: {};
            output: {
                requestId: string;
                db: {
                    readonly ok: boolean;
                    readonly latencyMs: number;
                    readonly code?: import("./services/diag.service").DbErrorCode | undefined;
                    readonly message?: string | undefined;
                };
                circuit: {
                    readonly status: "open" | "closed" | "half_open";
                    readonly lastErrorCode: import("./services/diag.service").DbErrorCode | null;
                    readonly consecutiveFailures: number;
                    readonly openedAt: number;
                };
                providers: {
                    opencode: boolean;
                    deepseek: boolean;
                    openrouter: boolean;
                };
                discovery: {
                    freeModelCount: number;
                    lastDiscovery: string | null;
                };
                recentFailures: readonly {
                    readonly ts: string;
                    readonly code: import("./services/diag.service").AuthFailureCode;
                    readonly requestId: string;
                    readonly message: string;
                }[];
                timestamp: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/models": {
        $get: {
            input: {};
            output: {
                object: string;
                architecture: string;
                data: any;
                strategy: string;
                autoDiscovered: boolean;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/ai"> | import("hono/types").MergeSchemaPath<{
    "/github-keys": {
        $get: {
            input: {
                query: {
                    username: string;
                };
            };
            output: {
                username: string;
                keys: never[];
                message: string;
                hint: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                query: {
                    username: string;
                };
            };
            output: {
                username: string;
                keyCount: number;
                keys: {
                    index: number;
                    type: string;
                    key: string;
                    fingerprint: string;
                    preview: string;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/github-keys/me": {
        $get: {
            input: {};
            output: {
                message: string;
                endpoint: string;
                headers: {
                    Authorization: string;
                    Accept: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/validate-ssh-key": {
        $post: {
            input: {};
            output: {
                valid: false;
                error: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                valid: boolean;
                type?: string | undefined;
                error?: string | undefined;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/utils"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema | import("hono/types").MergeSchemaPath<{
    "/connections": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/connect/:provider": {
        $get: {
            input: {
                param: {
                    provider: "github" | "gitlab" | "bitbucket";
                };
            };
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        };
    };
} & {
    "/callback/:provider": {
        $get: {
            input: {
                param: {
                    provider: "github" | "gitlab" | "bitbucket";
                };
            };
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
} & {
    "/connections/:provider": {
        $delete: {
            input: {
                param: {
                    provider: "github" | "gitlab" | "bitbucket";
                };
            };
            output: {
                disconnected: true;
                provider: "github" | "gitlab" | "bitbucket";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/servers/:id/repos/:provider": {
        $get: {
            input: {
                param: {
                    id: string;
                    provider: "github" | "gitlab" | "bitbucket";
                };
            };
            output: {
                repos: {
                    name: string;
                    fullName: string;
                    url: string;
                    sshUrl: string;
                    isPrivate: boolean;
                    defaultBranch: string;
                    description: string | null;
                    updatedAt: string;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/repos/:provider": {
        $post: {
            input: {
                param: {
                    id: string;
                    provider: "github" | "gitlab" | "bitbucket";
                };
            } & {
                json: {
                    name: string;
                    isPrivate?: boolean | undefined;
                };
            };
            output: {
                repo: {
                    name: string;
                    fullName: string;
                    url: string;
                    sshUrl: string;
                    isPrivate: boolean;
                    defaultBranch: string;
                    description: string | null;
                    updatedAt: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/links": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                repos: {
                    [x: string]: {
                        provider: string;
                        repoFullName: string;
                        repoUrl: string;
                        isPrivate: boolean;
                        linkedAt: string;
                        lastPushAt: string | null;
                    };
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/link": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            } & {
                query: {
                    app: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/link": {
        $post: {
            input: {
                json: {
                    provider: "github" | "gitlab" | "bitbucket";
                    repoFullName: string;
                    sandboxId: string;
                    repoUrl: string;
                    isPrivate?: boolean | undefined;
                    defaultBranch?: string | undefined;
                    skipSetup?: boolean | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                linked: true;
                linkId: `${string}-${string}-${string}-${string}-${string}`;
                sandboxId: string;
                repoFullName: string;
                repoUrl: string;
                defaultBranch: string;
                provider: any;
                providerUsername: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/link": {
        $delete: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                unlinked: true;
                sandboxId: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/push": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/force-push": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/pull": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/servers/:id/credentials-synced": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                synced: true;
                app: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/">, "/api/git"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema | import("hono/types").MergeSchemaPath<{
    "/connections": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/connect/:provider": {
        $get: {
            input: {
                param: {
                    provider: "vercel" | "supabase" | "neon" | "planetscale" | "stripe";
                };
            };
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        };
    };
} & {
    "/callback/:provider": {
        $get: {
            input: {
                param: {
                    provider: "vercel" | "supabase" | "neon" | "planetscale" | "stripe";
                };
            };
            output: {};
            outputFormat: string;
            status: import("hono/utils/http-status").StatusCode;
        };
    };
} & {
    "/connections/:provider": {
        $delete: {
            input: {
                param: {
                    provider: "vercel" | "supabase" | "neon" | "planetscale" | "stripe";
                };
            };
            output: {
                disconnected: true;
                provider: "vercel" | "supabase" | "neon" | "planetscale" | "stripe";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/supabase/:id/create-db": {
        $post: {
            input: {
                json: {
                    sandboxId: string;
                    region?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                projectRef: string;
                projectName: string;
                region: string;
                supabaseUrl: string;
                databaseUrl: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/supabase/:id/databases": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/supabase/:id/sync-credentials": {
        $post: {
            input: {
                json: {
                    sandboxId: string;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                synced: true;
                keys: string[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/supabase/:id/database/:sandboxId": {
        $delete: {
            input: {
                param: {
                    id: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                removed: true;
                sandboxId: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/"> | import("hono/types").MergeSchemaPath<{
    "/cloudflare/connect": {
        $get: {
            input: {};
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        };
    };
} & {
    "/cloudflare/callback": {
        $get: {
            input: {};
            output: undefined;
            outputFormat: "redirect";
            status: 302;
        };
    };
} & {
    "/cloudflare/disconnect": {
        $delete: {
            input: {};
            output: {
                disconnected: true;
                provider: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/">, "/api/integrations"> | import("hono/types").MergeSchemaPath<{
    "/:id": {
        $post: {
            input: {
                json: {
                    provider: string;
                    sandboxId: string;
                    connectionId: string;
                    gitOrg: string;
                    gitRepo: string;
                    gitRef: string;
                    commitSha: string;
                    environment?: string | undefined;
                    projectName?: string | undefined;
                    framework?: string | undefined;
                    gateTokenId?: string | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                status: import("./services/publish/types").DeploymentStatus;
                provider: string;
                url: string | null;
                providerDashboardUrl: string | null;
                providerDeploymentId: string | null;
                requestedAt: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/history/:serverId/:sandboxId": {
        $get: {
            input: {
                query: {
                    limit?: string | string[] | undefined;
                    offset?: string | string[] | undefined;
                };
            } & {
                param: {
                    serverId: string;
                } & {
                    sandboxId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/config/:serverId/:sandboxId": {
        $get: {
            input: {
                param: {
                    serverId: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    serverId: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                config: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/config/:serverId/:sandboxId": {
        $put: {
            input: {
                json: {
                    provider: string;
                    connectionId: string;
                    branch?: string | undefined;
                    framework?: string | undefined;
                    providerProjectId?: string | undefined;
                };
            } & {
                param: {
                    serverId: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    provider: string;
                    connectionId: string;
                    branch?: string | undefined;
                    framework?: string | undefined;
                    providerProjectId?: string | undefined;
                };
            } & {
                param: {
                    serverId: string;
                } & {
                    sandboxId: string;
                };
            };
            output: {
                config: any;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/webhook/:provider": {
        $post: {
            input: {
                param: {
                    provider: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    provider: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                param: {
                    provider: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                param: {
                    provider: string;
                };
            };
            output: {
                received: true;
                matched: false;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    provider: string;
                };
            };
            output: {
                received: true;
                matched: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/publish"> | import("hono/types").MergeSchemaPath<{
    "/device-flow/start": {
        $post: {
            input: {};
            output: {
                device_code: string;
                user_code: string;
                verification_uri: string;
                expires_in: number;
                interval: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/device-flow/poll": {
        $post: {
            input: {};
            output: {
                status: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/device-flow/approve": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        };
    };
} & {
    "/tunnel/config": {
        $post: {
            input: {};
            output: {
                error: string;
                upgrade_url: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {};
            output: {
                toml_config: string;
                public_url: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/tunnel/expose": {
        $post: {
            input: {};
            output: {
                error: string;
                upgrade_url: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {};
            output: {
                public_url: string;
                updated_toml: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/build/android": {
        $post: {
            input: {};
            output: {
                error: string;
                upgrade_url: string;
            };
            outputFormat: "json";
            status: 402;
        } | {
            input: {};
            output: {
                job_id: `${string}-${string}-${string}-${string}-${string}`;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/build/status/:id": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/mobile"> | import("hono/types").MergeSchemaPath<{
    "/register": {
        $post: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/unregister": {
        $delete: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/tokens": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/preferences": {
        $patch: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                success: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/send": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                success: true;
                sent: number;
                cleaned: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/push"> | import("hono/types").MergeSchemaPath<{
    "/verify-token": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/byos"> | import("hono/types").MergeSchemaPath<{
    "/current": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {};
            output: any;
            outputFormat: "json";
            status: 201;
        };
    };
}, "/api/byos/manifest"> | import("hono/types").MergeSchemaPath<{
    "/checkout": {
        $post: {
            input: {
                json: {
                    serverId: string;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    serverId: string;
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                checkoutUrl: string | null;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/cli-checkout": {
        $post: {
            input: {
                json: {
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    interval?: "monthly" | "annual" | undefined;
                };
            };
            output: {
                checkoutUrl: string | null;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/activate": {
        $post: {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                activated: true;
                originTag: string;
                aiHost: string;
                appHost: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/deactivate": {
        $post: {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                deactivated: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/ip-change": {
        $post: {
            input: {
                json: {
                    newIpAddress: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/byos/managed"> | import("hono/types").MergeSchemaPath<{
    "/upload-url": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 503;
        } | {
            input: {};
            output: {
                backupId: `${string}-${string}-${string}-${string}-${string}`;
                uploadUrl: string;
                r2Key: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/complete": {
        $post: {
            input: {
                json: {
                    sha256: string;
                    version: string;
                    sizeBytes: number;
                    backupType?: "manual" | "daily" | "weekly" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    sha256: string;
                    version: string;
                    sizeBytes: number;
                    backupType?: "manual" | "daily" | "weekly" | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    sha256: string;
                    version: string;
                    sizeBytes: number;
                    backupType?: "manual" | "daily" | "weekly" | undefined;
                };
            };
            output: {
                backupId: `${string}-${string}-${string}-${string}-${string}`;
                expiresAt: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:serverId": {
        $get: {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:serverId/restore": {
        $post: {
            input: {
                json: {
                    backupId: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/trigger": {
        $post: {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    serverId: string;
                };
            };
            output: {
                triggered: true;
                serverId: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/byos/backup"> | import("hono/types").MergeSchemaPath<{
    "/init": {
        $post: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/upload-urls": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                urls: {
                    [x: string]: string;
                };
                r2Prefix: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/download-urls": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {};
            output: {
                urls: {
                    [x: string]: string;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/restore": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                status: string;
                migrationId: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/status": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/tunnel/reroute": {
        $post: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/export": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                status: string;
                migrationId: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/cleanup": {
        $post: {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                ok: true;
                deleted: number;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                param: {
                    id: string;
                };
            };
            output: {
                error: any;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/provision": {
        $post: {
            input: {};
            output: {
                serverId: string;
                domain: string;
                status: "error" | "creating" | "provisioning" | "running" | "pool_ready" | "pending_deletion" | "destroying" | "hibernated" | "upgrading" | "downgrading" | "frozen" | "pool_assigned";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/api/byos/migration"> | import("hono/types").MergeSchemaPath<{
    "/request": {
        $post: {
            input: {
                json: {
                    serverId: string;
                    operation: "rebuild" | "rescue_boot" | "volume_reattach" | "snapshot_restore";
                    justification: string;
                    ttlSeconds?: number | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    serverId: string;
                    operation: "rebuild" | "rescue_boot" | "volume_reattach" | "snapshot_restore";
                    justification: string;
                    ttlSeconds?: number | undefined;
                };
            };
            output: {
                approvalId: string;
                expiresAt: string;
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    serverId: string;
                    operation: "rebuild" | "rescue_boot" | "volume_reattach" | "snapshot_restore";
                    justification: string;
                    ttlSeconds?: number | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
} & {
    "/:id/approve": {
        $post: {
            input: {
                json?: {} | undefined;
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json?: {} | undefined;
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
} & {
    "/server/:serverId": {
        $get: {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/breakglass"> | import("hono/types").MergeSchemaPath<{
    "/": {
        $post: {
            input: {
                json: {
                    components: Record<string, {
                        sha256: string;
                        path: string;
                        size: number;
                        version: string;
                        format: "bash" | "elf" | "tarball" | "nodejs-tarball";
                        dependsOn: string[];
                        restartOrder: number;
                        restartUnit: string | null;
                        subcomponents?: string[] | undefined;
                        livenessProbe?: {
                            url: string;
                            timeoutMs: number;
                        } | undefined;
                        requiredFeatureFlags?: string[] | undefined;
                    }>;
                    publishedBy?: string | null | undefined;
                    minQuorum?: number | undefined;
                    chainOverride?: {
                        reason: string;
                        previousVersion: number | null;
                        approvedBy: string;
                        incidentId: string;
                    } | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 503;
        } | {
            input: {
                json: {
                    components: Record<string, {
                        sha256: string;
                        path: string;
                        size: number;
                        version: string;
                        format: "bash" | "elf" | "tarball" | "nodejs-tarball";
                        dependsOn: string[];
                        restartOrder: number;
                        restartUnit: string | null;
                        subcomponents?: string[] | undefined;
                        livenessProbe?: {
                            url: string;
                            timeoutMs: number;
                        } | undefined;
                        requiredFeatureFlags?: string[] | undefined;
                    }>;
                    publishedBy?: string | null | undefined;
                    minQuorum?: number | undefined;
                    chainOverride?: {
                        reason: string;
                        previousVersion: number | null;
                        approvedBy: string;
                        incidentId: string;
                    } | undefined;
                };
            };
            output: {
                id: string;
                version: number;
                jws: string;
            };
            outputFormat: "json";
            status: 201;
        } | {
            input: {
                json: {
                    components: Record<string, {
                        sha256: string;
                        path: string;
                        size: number;
                        version: string;
                        format: "bash" | "elf" | "tarball" | "nodejs-tarball";
                        dependsOn: string[];
                        restartOrder: number;
                        restartUnit: string | null;
                        subcomponents?: string[] | undefined;
                        livenessProbe?: {
                            url: string;
                            timeoutMs: number;
                        } | undefined;
                        requiredFeatureFlags?: string[] | undefined;
                    }>;
                    publishedBy?: string | null | undefined;
                    minQuorum?: number | undefined;
                    chainOverride?: {
                        reason: string;
                        previousVersion: number | null;
                        approvedBy: string;
                        incidentId: string;
                    } | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/:id": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/status": {
        $get: {
            input: {
                param: {
                    id: string;
                };
            };
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/:id/promote": {
        $post: {
            input: {
                json: {
                    to: "canary" | "early" | "stable" | "late";
                    promotedBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    to: "canary" | "early" | "stable" | "late";
                    promotedBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                version: number;
                jws: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    to: "canary" | "early" | "stable" | "late";
                    promotedBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        };
    };
} & {
    "/:id/rollback": {
        $post: {
            input: {
                json: {
                    reason: string;
                    rolledBackBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    reason: string;
                    rolledBackBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                version: number;
                jws: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    reason: string;
                    rolledBackBy?: string | null | undefined;
                };
            } & {
                param: {
                    id: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/presign-upload": {
        $post: {
            input: {
                json: {
                    sha256: string;
                    size: number;
                    version: string;
                    format: "bash" | "elf" | "tarball" | "nodejs-tarball";
                    component: "ellul-namespaced" | "ellul-env" | "ellul-mount-volume" | "ellul-crypto" | "core-runtime" | "ide";
                };
            };
            output: {
                url: string;
                key: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    sha256: string;
                    size: number;
                    version: string;
                    format: "bash" | "elf" | "tarball" | "nodejs-tarball";
                    component: "ellul-namespaced" | "ellul-env" | "ellul-mount-volume" | "ellul-crypto" | "core-runtime" | "ide";
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/api/admin/agent-manifests"> | import("hono/types").MergeSchemaPath<{
    "/provision-config": {
        $get: {
            input: {};
            output: {
                snapshotIds: {
                    [x: string]: {
                        [x: string]: string;
                    };
                };
                prevSnapshotIds: {
                    [x: string]: {
                        [x: string]: string;
                    };
                };
                cacheHashes: {
                    [x: string]: string;
                };
                cacheVersion: string;
                latestBakeTimestamp: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/provision-config": {
        $post: {
            input: {
                json: {
                    cacheVersion: string;
                    arch: string;
                    snapshotId: string;
                    provider: string;
                    cacheHash: string;
                    writtenBy: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    cacheVersion: string;
                    arch: string;
                    snapshotId: string;
                    provider: string;
                    cacheHash: string;
                    writtenBy: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
} & {
    "/releases": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/releases": {
        $post: {
            input: {
                json: {
                    version: string;
                    commitSha: string;
                    components?: string[] | Record<string, unknown> | undefined;
                    manifestId?: string | null | undefined;
                    builtBy?: string | undefined;
                    cloudBuildId?: string | null | undefined;
                };
            };
            output: {
                id: `${string}-${string}-${string}-${string}-${string}`;
                version: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {
                json: {
                    version: string;
                    commitSha: string;
                    components?: string[] | Record<string, unknown> | undefined;
                    manifestId?: string | null | undefined;
                    builtBy?: string | undefined;
                    cloudBuildId?: string | null | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 500;
        };
    };
}, "/api/admin/platform"> | import("hono/types").MergeSchemaPath<{
    "/custom-domains": {
        $get: {
            input: {};
            output: any;
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/custom-domains/:serverId/suspend": {
        $post: {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/custom-domains/:serverId/resume": {
        $post: {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 409;
        } | {
            input: {
                param: {
                    serverId: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
} & {
    "/custom-domains/:serverId/takedown": {
        $post: {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    reason: string;
                };
            } & {
                param: {
                    serverId: string;
                };
            };
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/api/admin"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema | import("hono/types").MergeSchemaPath<{
    "/custom-hostname-status": {
        $post: {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 503;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {};
            output: {
                ok: true;
                reason: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                ok: true;
                unchanged: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        } | {
            input: {};
            output: {
                ok: true;
                status: "active" | "pending_validation" | "validating" | "issuing_cert" | "validation_failed" | "cert_failed" | "suspended";
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
        };
    };
}, "/cloudflare">, "/api/webhooks"> | import("hono/types").MergeSchemaPath<import("hono/types").BlankSchema, "/api/cron">, "/", any>;
export { app };
export type AppType = typeof app;
