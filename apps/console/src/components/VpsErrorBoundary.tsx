// SPDX-License-Identifier: MIT
"use client";

import { Component, type ReactNode } from "react";
import { useTranslations } from "next-intl";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

function VpsErrorFallback({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("console.errorBoundary");

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-sodium/10 flex items-center justify-center mb-4">
        <svg
          className="h-6 w-6 text-sodium"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
      </div>
      <p className="text-sm text-cream/75 mb-1">
        {t("cannotCommunicate")}
      </p>
      <p className="text-xs text-cream/60 mb-4">
        {t("stillRunning")}
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-2 text-sm font-medium text-cream bg-secondary hover:bg-secondary rounded-lg border border-border transition-colors"
      >
        {t("retry")}
      </button>
    </div>
  );
}

// Error boundary for VPS-dependent UI sections.
export class VpsErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <VpsErrorFallback
          onRetry={() => {
            this.setState({ hasError: false });
            window.location.reload();
          }}
        />
      );
    }

    return this.props.children;
  }
}
