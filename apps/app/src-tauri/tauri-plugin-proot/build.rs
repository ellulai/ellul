const COMMANDS: &[&str] = &[
    "proot_start",
    "proot_stop",
    "proot_status",
    "proot_health",
    "proot_setup_status",
    "proot_setup_start",
    "proot_switch_to_local",
    "proot_tunnel_start",
    "proot_tunnel_stop",
    "proot_tunnel_status",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
