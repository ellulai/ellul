const COMMANDS: &[&str] = &[
    "proot_start",
    "proot_stop",
    "proot_status",
    "proot_health",
    "proot_setup_status",
    "proot_setup_start",
    "proot_switch_to_local",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
