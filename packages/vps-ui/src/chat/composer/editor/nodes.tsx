// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/ComposerPromptEditor.tsx

import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { type ReactElement } from "react";
import { FileIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
} from "../../lib/composer-inline-chip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

// FileIcon replaces upstream's vscode per-filetype icon (deviation #10)
function basenameOfPath(path: string): string {
  const segments = path.split("/").filter((part) => part.length > 0);
  return segments[segments.length - 1] ?? path;
}

type SerializedComposerMentionNode = Spread<
  {
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedLexicalNode
>;

type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    skillLabel?: string;
    skillDescription?: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedLexicalNode
>;

function ComposerMentionDecorator(props: { path: string }) {
  const chip = (
    <span
      className={COMPOSER_INLINE_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{basenameOfPath(props.path)}</span>
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup
        side="top"
        className="max-w-[30rem] whitespace-normal leading-tight wrap-anywhere"
      >
        {props.path}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerMentionNode extends DecoratorNode<ReactElement> {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path).updateFromJSON(serializedNode);
  }

  constructor(path: string, key?: NodeKey) {
    super(key);
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    this.__path = normalizedPath;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return `@${this.__path}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerMentionDecorator path={this.__path} />;
  }
}

export function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
}

const SKILL_CHIP_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

function ComposerSkillDecorator(props: { skillLabel: string; skillDescription: string | null }) {
  const chip = (
    <span
      className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-skill-chip="true"
    >
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.skillLabel}</span>
    </span>
  );

  if (!props.skillDescription) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-[30rem] whitespace-normal leading-tight">
        {props.skillDescription}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerSkillNode extends DecoratorNode<ReactElement> {
  __skillName: string;
  __skillLabel: string;
  __skillDescription: string | null;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(
      node.__skillName,
      node.__skillLabel,
      node.__skillDescription,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(
      serializedNode.skillName,
      serializedNode.skillLabel ?? serializedNode.skillName,
      serializedNode.skillDescription ?? null,
    ).updateFromJSON(serializedNode);
  }

  constructor(
    skillName: string,
    skillLabel: string,
    skillDescription: string | null,
    key?: NodeKey,
  ) {
    super(key);
    const normalizedSkillName = skillName.startsWith("$") ? skillName.slice(1) : skillName;
    this.__skillName = normalizedSkillName;
    this.__skillLabel = skillLabel;
    this.__skillDescription = skillDescription;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      skillLabel: this.__skillLabel,
      ...(this.__skillDescription ? { skillDescription: this.__skillDescription } : {}),
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return `$${this.__skillName}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return (
      <ComposerSkillDecorator
        skillLabel={this.__skillLabel}
        skillDescription={this.__skillDescription}
      />
    );
  }
}

export function $createComposerSkillNode(
  skillName: string,
  skillLabel: string,
  skillDescription: string | null,
): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(skillName, skillLabel, skillDescription));
}

export type ComposerInlineTokenNode = ComposerMentionNode | ComposerSkillNode;

export function isComposerInlineTokenNode(candidate: unknown): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode
  );
}
