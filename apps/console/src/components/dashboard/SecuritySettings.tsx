// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  ShieldCheck,
  ExternalLink,
  Github,
  Mail,
} from "lucide-react";

interface SecuritySettingsProps {
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  };
  // The OAuth provider the user signed in with
  provider?: "github" | "google";
}

// Security Settings Component
// This component informs users about their security status and
export function SecuritySettings({ user, provider = "github" }: SecuritySettingsProps) {
  const t = useTranslations("console.securitySettings");
  const [showTip, setShowTip] = useState(false);

  const providerConfig = {
    github: {
      name: t("providerName.github"),
      icon: Github,
      settingsUrl: "https://github.com/settings/security",
      color: "bg-gray-900",
    },
    google: {
      name: t("providerName.google"),
      icon: Mail,
      settingsUrl: "https://myaccount.google.com/security",
      color: "bg-blue-600",
    },
  };

  const currentProvider = providerConfig[provider];
  const ProviderIcon = currentProvider.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <Badge variant="default" className="bg-sodium">
            <ShieldCheck className="h-3 w-3 mr-1" />
            {t("oauthProtected")}
          </Badge>
        </div>
        <CardDescription>
          {t("securedThrough", { provider: currentProvider.name })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* OAuth Provider Info */}
        <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
          <div className={`p-3 rounded-full ${currentProvider.color} text-cream`}>
            <ProviderIcon className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium">{t("signedInWith", { provider: currentProvider.name })}</h3>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>

        {/* 2FA Information */}
        <div className="space-y-3">
          <h4 className="font-medium">{t("twoFactor")}</h4>
          <p className="text-sm text-muted-foreground">
            {t("twoFactorBody", { provider: currentProvider.name })}
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              variant="outline"
              onClick={() => window.open(currentProvider.settingsUrl, "_blank")}
            >
              <ProviderIcon className="h-4 w-4 mr-2" />
              {t("manageProviderSecurity", { provider: currentProvider.name })}
              <ExternalLink className="h-3 w-3 ml-2" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTip(!showTip)}
            >
              {showTip ? t("hideTip") : t("whyOauth")}
            </Button>
          </div>

          {showTip && (
            <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg text-sm space-y-2">
              <p className="font-medium text-blue-700 dark:text-blue-300">
                {t("whyOauthHeader")}
              </p>
              <ul className="list-disc list-inside space-y-1 text-blue-600 dark:text-blue-400">
                <li>{t("whyOauthBullet1")}</li>
                <li>{t("whyOauthBullet2", { provider: currentProvider.name })}</li>
                <li>{t("whyOauthBullet3")}</li>
                <li>{t("whyOauthBullet4")}</li>
                <li>{t("whyOauthBullet5")}</li>
              </ul>
            </div>
          )}
        </div>

        {/* Security Recommendations */}
        <div className="space-y-3 pt-4 border-t">
          <h4 className="font-medium">{t("recommendedHeader")}</h4>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 text-sodium flex-shrink-0" />
              <span>
                {t("recommended1", { provider: currentProvider.name })}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 text-sodium flex-shrink-0" />
              <span>
                {t("recommended2")}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 text-sodium flex-shrink-0" />
              <span>
                {t("recommended3", { provider: currentProvider.name })}
              </span>
            </li>
          </ul>
        </div>

        {/* Teleport Access Info */}
        <div className="space-y-3 pt-4 border-t">
          <h4 className="font-medium">{t("teleportHeader")}</h4>
          <p className="text-sm text-muted-foreground">
            {t.rich("teleportBody", {
              email: () => <code className="text-xs bg-muted px-1 rounded">{user.email}</code>,
            })}
          </p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>• {t("teleportBullet1")}</li>
            <li>• {t("teleportBullet2")}</li>
            <li>• {t("teleportBullet3")}</li>
            <li>• {t("teleportBullet4")}</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
