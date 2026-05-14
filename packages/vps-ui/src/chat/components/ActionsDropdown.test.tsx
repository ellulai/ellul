// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ActionsDropdown render + interaction tests.
 *
 * Verifies every rendering rule spelled out in the component's module
 * doc-comment: hidden when empty, hidden while loading-with-no-data,
 * visible when pending gate, confirmation flow for destructive actions.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ResolvedAction } from "@ellul.ai/types";
import { ActionsDropdown } from "./ActionsDropdown";

function mkAction(override?: Partial<ResolvedAction>): ResolvedAction {
  return {
    id: "deploy",
    label: "Deploy",
    description: "Ship to production",
    iconKey: "rocket",
    severity: "normal",
    context: "workspace",
    integrationCategory: "deploy",
    gateType: "deploy",
    available: true,
    ...override,
  };
}

describe("ActionsDropdown", () => {
  it("renders nothing when there is no active project", () => {
    const { container } = render(
      <ActionsDropdown
        resolvedActions={[mkAction()]}
        loading={false}
        hasProject={false}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no resolved actions and no pending gate", () => {
    const { container } = render(
      <ActionsDropdown
        resolvedActions={[]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while loading if there are no actions yet", () => {
    const { container } = render(
      <ActionsDropdown
        resolvedActions={[]}
        loading={true}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the pill when at least one action resolves", async () => {
    render(
      <ActionsDropdown
        resolvedActions={[
          mkAction({ id: "deploy", label: "Deploy" }),
          mkAction({
            id: "git-push",
            label: "Git Sync",
            description: "Push code to remote",
            iconKey: "git-branch",
          }),
        ]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );

    const pill = screen.getByRole("button", { name: /actions/i });
    expect(pill).toBeInTheDocument();

    await userEvent.click(pill);
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Deploy"),
        expect.stringContaining("Git Sync"),
      ]),
    );
  });

  it("invokes onExecute for a non-destructive click", async () => {
    const onExecute = vi.fn();
    render(
      <ActionsDropdown
        resolvedActions={[mkAction({ id: "deploy", label: "Deploy" })]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={onExecute}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /actions/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /deploy/i }));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0].id).toBe("deploy");
  });

  it("gates destructive actions behind a confirmation row", async () => {
    const onExecute = vi.fn();
    render(
      <ActionsDropdown
        resolvedActions={[
          mkAction({
            id: "db-drop-table",
            label: "Drop Table",
            severity: "destructive",
            requiresConfirmation: true,
          }),
        ]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={onExecute}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /actions/i }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /drop table/i }),
    );

    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByText(/this is destructive/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending confirmation and returns to the menu", async () => {
    render(
      <ActionsDropdown
        resolvedActions={[
          mkAction({
            id: "db-drop-table",
            label: "Drop Table",
            severity: "destructive",
            requiresConfirmation: true,
          }),
        ]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /actions/i }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /drop table/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByText(/this is destructive/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /drop table/i }),
    ).toBeInTheDocument();
  });

  it("surfaces an agent-pending indicator and stays visible with only a gate", () => {
    render(
      <ActionsDropdown
        resolvedActions={[
          mkAction({ id: "git-push", label: "Git Sync" }),
        ]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId="git-push"
        onExecute={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /actions/i }),
    ).toBeInTheDocument();
  });

  it("injects a pending-gate action into the menu even when the resolver hid it", async () => {
    // Regression: if the agent is requesting a gate for an action that the
    // resolver filtered out (no git remote, no deploy config, etc.), the
    // user must still see it so they can respond. The dropdown pulls the
    // missing action from the shared registry and shows it at the top.
    const onExecute = vi.fn();
    render(
      <ActionsDropdown
        resolvedActions={[]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId="git-push"
        onExecute={onExecute}
      />,
    );

    const pill = screen.getByRole("button", { name: /actions/i });
    expect(pill).toBeInTheDocument();

    await userEvent.click(pill);
    const item = screen.getByRole("menuitem", { name: /git sync/i });
    await userEvent.click(item);
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0].id).toBe("git-push");
  });

  it("ignores a pending-gate for an unknown action id", () => {
    const { container } = render(
      <ActionsDropdown
        resolvedActions={[]}
        loading={false}
        hasProject={true}
        executingActionId={null}
        pendingGateActionId="never-heard-of-it"
        onExecute={() => {}}
      />,
    );
    // Unknown id can't be looked up in the registry, so the pill stays hidden.
    expect(container).toBeEmptyDOMElement();
  });

  it("disables sibling actions while one is executing", async () => {
    render(
      <ActionsDropdown
        resolvedActions={[
          mkAction({ id: "deploy", label: "Deploy" }),
          mkAction({
            id: "git-push",
            label: "Git Sync",
            description: "Push code to remote",
            iconKey: "git-branch",
          }),
        ]}
        loading={false}
        hasProject={true}
        executingActionId="deploy"
        pendingGateActionId={null}
        onExecute={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /actions/i }));
    const git = screen.getByRole("menuitem", { name: /git sync/i });
    expect(git).toBeDisabled();
  });
});
