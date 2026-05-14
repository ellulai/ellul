// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/CompactComposerControlsMenu.tsx

import { ProviderInteractionMode, RuntimeMode } from "@ellul.ai/types";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const tChat = useTranslations("chat");
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label={tChat("compactControls.moreControlsAria")}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <MenuGroupLabel>{tChat("compactControls.modeGroupLabel")}</MenuGroupLabel>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">{tChat("compactControls.chat")}</MenuRadioItem>
              <MenuRadioItem value="plan">{tChat("compactControls.plan")}</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <MenuGroupLabel>{tChat("compactControls.accessGroupLabel")}</MenuGroupLabel>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">{tChat("compactControls.supervised")}</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">{tChat("compactControls.autoAcceptEdits")}</MenuRadioItem>
          <MenuRadioItem value="full-access">{tChat("compactControls.fullAccess")}</MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? tChat("compactControls.hidePlanSidebar", { label: props.planSidebarLabel.toLowerCase() })
                : tChat("compactControls.showPlanSidebar", { label: props.planSidebarLabel.toLowerCase() })}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
