// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-native-auth",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "tauri-plugin-native-auth", targets: ["tauri-plugin-native-auth"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-native-auth",
            dependencies: [.product(name: "Tauri", package: "Tauri")],
            path: "Sources"
        )
    ]
)
