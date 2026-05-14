// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/ui/combobox.tsx

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@shared/utils";

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  return <ComboboxPrimitive.Root {...props} />;
}

function ComboboxInput({
  className,
  startAddon,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  startAddon?: React.ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative w-full text-foreground">
      {startAddon ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 start-0 z-10 flex items-center ps-3 opacity-70 [&_svg]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      ) : null}
      <ComboboxPrimitive.Input
        className={cn(
          "w-full h-8 rounded-md border border-input bg-background/50 px-3 text-sm outline-none",
          "placeholder:text-muted-foreground/60",
          "focus-visible:border-sodium/60 focus-visible:ring-2 focus-visible:ring-sodium/20",
          "disabled:opacity-60",
          startAddon && "ps-9",
          className,
        )}
        data-slot="combobox-input"
        {...props}
      />
    </div>
  );
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger className={className} data-slot="combobox-trigger" {...props}>
      {children}
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50 select-none"
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <span
          className={cn(
            "relative flex max-h-full min-w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover/95 text-popover-foreground shadow-panel-lift backdrop-blur-sm transition-[scale,opacity] duration-150 ease-out",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxItem({
  className,
  contentClassName,
  children,
  hideIndicator = false,
  ...props
}: ComboboxPrimitive.Item.Props & {
  contentClassName?: string;
  hideIndicator?: boolean;
}) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "grid min-h-7 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm px-2 py-1 text-sm outline-none",
        "hover:bg-sodium/10",
        "data-[highlighted]:bg-sodium/15 data-[highlighted]:text-cream",
        "data-[selected]:bg-sodium/20 data-[selected]:text-cream",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-60",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <ComboboxPrimitive.ItemIndicator className={cn("col-start-1", hideIndicator && "hidden")}>
        <CheckIcon className="size-3.5 text-sodium" />
      </ComboboxPrimitive.ItemIndicator>
      <div
        className={cn(
          hideIndicator ? "col-span-full col-start-1" : "col-start-2",
          contentClassName,
        )}
      >
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border/60 last:hidden", className)}
      data-slot="combobox-separator"
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      className={cn("[[role=group]+&]:mt-1.5", className)}
      data-slot="combobox-group"
      {...props}
    />
  );
}

function ComboboxGroupLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      className={cn(
        "px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55",
        className,
      )}
      data-slot="combobox-group-label"
      {...props}
    />
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn("p-2 text-center text-sm text-muted-foreground", className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxRow({ className, ...props }: ComboboxPrimitive.Row.Props) {
  return <ComboboxPrimitive.Row className={className} data-slot="combobox-row" {...props} />;
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("overflow-y-auto p-1", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxListVirtualized({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("p-1", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxStatus({ className, ...props }: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0",
        className,
      )}
      data-slot="combobox-status"
      {...props}
    />
  );
}

function ComboboxCollection(props: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

const useComboboxFilter = ComboboxPrimitive.useFilter;

export {
  Combobox,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxSeparator,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxEmpty,
  ComboboxValue,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxStatus,
  ComboboxRow,
  ComboboxCollection,
  useComboboxFilter,
};
