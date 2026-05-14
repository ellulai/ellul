// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircle, Rocket, Zap, Terminal } from "lucide-react";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { api } from "@/lib/api";

interface CreateStackFormProps {
  onSuccess?: () => void;
}

// CreateStackForm - Deploy a new ellul server
export function CreateStackForm({ onSuccess }: CreateStackFormProps) {
  const t = useTranslations("console.createStack");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [stackName, setStackName] = useState("");
  const [errors, setErrors] = useState<{ name?: string }>({});

  // Create server mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const response = await api.api.servers.$post({
        json: {
          name: stackName.trim() || undefined,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          (error as { error?: string }).error || t("createFailed")
        );
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
      onSuccess?.();
      router.push("/dashboard");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    createMutation.mutate();
  };

  return (
    <Card className="w-full max-w-lg mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <EllulLogo className="h-5 w-5 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription>
          {t("description")}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Stack Name Field */}
          <div className="space-y-2">
            <Label htmlFor="stack-name">{t("stackName")}</Label>
            <Input
              id="stack-name"
              type="text"
              placeholder={t("namePlaceholder")}
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              maxLength={50}
              className={errors.name ? "border-destructive" : ""}
            />
            {errors.name && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {errors.name}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("nameHint")}
            </p>
          </div>

          {/* Web Terminal Info */}
          <div className="rounded-lg bg-card/20 border border-border p-4">
            <div className="flex items-start gap-3">
              <Zap className="h-5 w-5 text-sodium mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-sodium">
                  {t("webTerminalTitle")}
                </p>
                <p className="text-sm text-sodium mt-1">
                  {t.rich("webTerminalBody", {
                    code: (chunks) => <code className="bg-secondary px-1 rounded">{chunks}</code>,
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* What you get */}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("included")}</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />{t("feature1")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("feature2")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("feature3")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("feature4")}
              </li>
            </ul>
          </div>

          {/* Error Message */}
          {createMutation.error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {createMutation.error.message}
              </p>
            </div>
          )}

          {/* Submit Button */}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <>
                <Spinner size="sm" className="mr-2" />
                {t("provisioning")}
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4 mr-2" />
                {t("createServer")}
              </>
            )}
          </Button>

          {createMutation.isPending && (
            <p className="text-xs text-center text-muted-foreground">
              {t("provisioningHint")}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
