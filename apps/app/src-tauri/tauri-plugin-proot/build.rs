const COMMANDS: &[&str] = &[
    "proot_start",
    "proot_stop",
    "proot_status",
    "proot_health",
    "proot_setup_status",
    "proot_setup_start",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
