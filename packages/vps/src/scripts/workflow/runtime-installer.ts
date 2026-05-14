// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import runtimeInstallerShell from '@vps/shell/packages/runtime-installer.sh';
import { RUNTIME_VERSIONS, APT_RUNTIME_PACKAGES } from '../../pinned-versions';

export function getRuntimeInstallerScript(): string {
  return runtimeInstallerShell
    .split('__GO_VERSION__').join(RUNTIME_VERSIONS.go)
    .split('__RUST_VERSION__').join(RUNTIME_VERSIONS.rust)
    .split('__DOTNET_VERSION__').join(RUNTIME_VERSIONS.dotnet)
    .split('__JAVA_VERSION__').join(RUNTIME_VERSIONS.java)
    .split('__FLUTTER_VERSION__').join(RUNTIME_VERSIONS.flutter)
    .split('__BUN_VERSION__').join(RUNTIME_VERSIONS.bun)
    .split('__COMPOSER_VERSION__').join(RUNTIME_VERSIONS.composer)
    .split('__APT_RUBY__').join(APT_RUNTIME_PACKAGES.ruby.join(' '))
    .split('__APT_ELIXIR__').join(APT_RUNTIME_PACKAGES.elixir.join(' '))
    .split('__APT_PHP__').join(APT_RUNTIME_PACKAGES.php.join(' '))
    .split('__APT_DART__').join(APT_RUNTIME_PACKAGES.dart.join(' '))
    .split('__APT_JAVA_PREREQS__').join(APT_RUNTIME_PACKAGES.java_prereqs.join(' '))
    .split('__APT_JAVA__').join(APT_RUNTIME_PACKAGES.java.join(' '));
}
