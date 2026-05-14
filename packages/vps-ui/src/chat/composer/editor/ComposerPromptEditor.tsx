// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/ComposerPromptEditor.tsx

import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $getRoot, type EditorState } from "lexical";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEventHandler,
  type Ref,
} from "react";

import type { ServerProviderSkill } from "@ellul.ai/types";
import { cn } from "@shared/utils";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "../../lib/composer-logic";
import { ComposerMentionNode, ComposerSkillNode } from "./nodes";
import {
  $readExpandedSelectionOffsetFromEditorState,
  $readSelectionOffsetFromEditorState,
  $setComposerEditorPrompt,
  $setSelectionAtComposerOffset,
  clampExpandedCursor,
  skillMetadataByName,
  skillSignature,
} from "./editor-state";
import {
  ComposerCommandKeyPlugin,
  ComposerInlineTokenArrowPlugin,
  ComposerInlineTokenBackspacePlugin,
  ComposerInlineTokenSelectionNormalizePlugin,
} from "./plugins";
import { ComposerSurroundSelectionPlugin } from "./surround-selection-plugin";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
  };
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  className?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  skills,
  disabled,
  placeholder,
  className,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const skillsSignatureValue = skillSignature(skills);
  const skillsSignatureRef = useRef(skillsSignatureValue);
  const skillMetadataRef = useRef(skillMetadataByName(skills));
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
  });
  const isApplyingControlledUpdateRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useLayoutEffect(() => {
    skillMetadataRef.current = skillMetadataByName(skills);
  }, [skills]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const skillsChanged = skillsSignatureRef.current !== skillsSignatureValue;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !skillsChanged
    ) {
      return;
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
    };
    skillsSignatureRef.current = skillsSignatureValue;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !skillsChanged && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState = previousSnapshot.value !== value || skillsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, skillMetadataRef.current);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, skillsSignatureValue, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
      );
    },
    [editor],
  );

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
  } => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      readSnapshot,
    }),
    [focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor
      ) {
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(nextValue, nextCursor, nextExpandedCursor, cursorAdjacentToMention);
    });
  }, []);

  return (
    <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "block max-h-[200px] min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[14px] leading-relaxed text-foreground focus:outline-none",
                className,
              )}
              data-testid="composer-editor"
              aria-placeholder={placeholder}
              placeholder={<span />}
              onPaste={onPaste}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute inset-0 truncate text-[14px] leading-relaxed text-muted-foreground/35">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
        <ComposerSurroundSelectionPlugin skills={skills} />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <HistoryPlugin />
      </div>
  );
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  { value, cursor, skills, disabled, placeholder, className, onChange, onCommandKeyDown, onPaste },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialSkillMetadataRef = useRef(skillMetadataByName(skills));
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "ellul-composer-editor",
      editable: true,
      nodes: [ComposerMentionNode, ComposerSkillNode],
      editorState: () => {
        $setComposerEditorPrompt(initialValueRef.current, initialSkillMetadataRef.current);
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        skills={skills}
        disabled={disabled}
        placeholder={placeholder}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
});
