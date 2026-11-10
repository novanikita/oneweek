// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "OneweekKit",
    platforms: [.macOS(.v14)],
    products: [.library(name: "OneweekKit", targets: ["OneweekKit"])],
    targets: [
        .target(name: "OneweekKit"),
        .testTarget(name: "OneweekKitTests", dependencies: ["OneweekKit"]),
    ]
)
