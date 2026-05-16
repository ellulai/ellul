// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-shield",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "tauri-plugin-shield", targets: ["tauri-plugin-shield"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-shield",
            dependencies: [.product(name: "Tauri", package: "Tauri")],
            path: "Sources"
        )
    ]
)
