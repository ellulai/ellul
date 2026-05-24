const COMMANDS: &[&str] = &[
    "proot_start",
    "proot_stop",
    "proot_status",
    "proot_health",
    "proot_fetch",
    "proot_setup_status",
    "proot_setup_start",
    "proot_switch_to_local",
    "proot_tunnel_start",
    "proot_tunnel_stop",
    "proot_tunnel_status",
    "proot_tunnel_set_auth",
    "proot_tunnel_set_subdomain",
    "proot_tunnel_get_config",
    "proot_tunnel_set_auto_expose",
    "proot_update_check",
    "proot_update_apply",
    "proot_update_cancel",
    "proot_update_get_settings",
    "proot_update_set_settings",
    "proot_migration_export_file",
    "proot_bootstrap_auth",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
