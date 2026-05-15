import AuthenticationServices
import UIKit
import Tauri

// MARK: - Apple Sign In Result

struct AppleSignInResult: Codable {
    let identityToken: String
    let userId: String
    let email: String?
    let givenName: String?
    let familyName: String?
}

// MARK: - Apple Sign In Delegate

class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<AppleSignInResult, Error>?

    func signIn() async throws -> AppleSignInResult {
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation

            let provider = ASAuthorizationAppleIDProvider()
            let request = provider.createRequest()
            request.requestedScopes = [.email, .fullName]

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    // MARK: - ASAuthorizationControllerDelegate

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            continuation?.resume(throwing: NSError(domain: "NativeAuth", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid credential type"]))
            return
        }

        guard let identityTokenData = credential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            continuation?.resume(throwing: NSError(domain: "NativeAuth", code: -2, userInfo: [NSLocalizedDescriptionKey: "Missing identity token"]))
            return
        }

        let result = AppleSignInResult(
            identityToken: identityToken,
            userId: credential.user,
            email: credential.email,
            givenName: credential.fullName?.givenName,
            familyName: credential.fullName?.familyName
        )

        continuation?.resume(returning: result)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
    }

    // MARK: - ASAuthorizationControllerPresentationContextProviding

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? UIWindow()
    }
}

// MARK: - Push Token Manager

class PushTokenManager: NSObject {
    static let shared = PushTokenManager()
    private var tokenContinuation: CheckedContinuation<String, Error>?
    private var cachedToken: String?
    private var observersRegistered = false

    func registerForPush() async throws -> String {
        // Return cached token if available
        if let cached = cachedToken {
            return cached
        }

        // Register for push token delivery notifications
        if !observersRegistered {
            observersRegistered = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(didReceiveDeviceToken(_:)),
                name: NSNotification.Name("UIApplicationDidRegisterForRemoteNotificationsNotification"),
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(didFailToRegisterPush(_:)),
                name: NSNotification.Name("UIApplicationDidFailToRegisterForRemoteNotificationsNotification"),
                object: nil
            )
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.tokenContinuation = continuation

            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }

            // Timeout after 10 seconds
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in
                if let cont = self?.tokenContinuation {
                    self?.tokenContinuation = nil
                    cont.resume(throwing: NSError(
                        domain: "NativeAuth",
                        code: -10,
                        userInfo: [NSLocalizedDescriptionKey: "Push registration timed out"]
                    ))
                }
            }
        }
    }

    @objc private func didReceiveDeviceToken(_ notification: Notification) {
        guard let tokenData = notification.object as? Data else { return }
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        cachedToken = token
        tokenContinuation?.resume(returning: token)
        tokenContinuation = nil
    }

    @objc private func didFailToRegisterPush(_ notification: Notification) {
        let error = notification.object as? Error ?? NSError(
            domain: "NativeAuth",
            code: -11,
            userInfo: [NSLocalizedDescriptionKey: "Push registration failed"]
        )
        tokenContinuation?.resume(throwing: error)
        tokenContinuation = nil
    }
}

// MARK: - Tauri Plugin

class NativeAuthPlugin: Plugin {
    private let appleSignInDelegate = AppleSignInDelegate()

    @objc override func load(webview: WKWebView) {
        // Plugin loaded
    }

    // Called from Tauri command: sign_in_apple
    @objc func signInApple(_ invoke: Invoke) {
        Task {
            do {
                let result = try await appleSignInDelegate.signIn()
                let data: [String: Any?] = [
                    "identity_token": result.identityToken,
                    "user_id": result.userId,
                    "email": result.email,
                    "given_name": result.givenName,
                    "family_name": result.familyName,
                ]
                invoke.resolve(data as [String: Any])
            } catch let error as ASAuthorizationError where error.code == .canceled {
                invoke.reject("Apple Sign In was cancelled")
            } catch {
                invoke.reject("Apple Sign In failed: \(error.localizedDescription)")
            }
        }
    }

    // Called from Tauri command: register_push
    // Registers for APNs remote notifications and returns the device token
    @objc func registerPush(_ invoke: Invoke) {
        Task {
            do {
                let token = try await PushTokenManager.shared.registerForPush()
                invoke.resolve(["token": token])
            } catch {
                invoke.reject("Push registration failed: \(error.localizedDescription)")
            }
        }
    }

    // Called from Tauri command: haptic_feedback
    // Triggers haptic feedback using UIImpactFeedbackGenerator
    @objc func hapticFeedback(_ invoke: Invoke) {
        guard let args = invoke.parseArgs(HapticFeedbackArgs.self) else {
            invoke.reject("Missing intensity argument")
            return
        }

        let style: UIImpactFeedbackGenerator.FeedbackStyle
        switch args.intensity {
        case "light":
            style = .light
        case "medium":
            style = .medium
        case "heavy":
            style = .heavy
        default:
            invoke.reject("Invalid intensity: \(args.intensity). Must be light, medium, or heavy")
            return
        }

        DispatchQueue.main.async {
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.impactOccurred()
            invoke.resolve()
        }
    }

    // Called from Tauri command: copy_to_clipboard
    @objc func copyToClipboard(_ invoke: Invoke) {
        guard let args = invoke.parseArgs(CopyToClipboardArgs.self) else {
            invoke.reject("Missing text argument")
            return
        }

        DispatchQueue.main.async {
            UIPasteboard.general.string = args.text
            invoke.resolve()
        }
    }

    // Called from Tauri command: share
    @objc func share(_ invoke: Invoke) {
        guard let args = invoke.parseArgs(ShareArgs.self) else {
            invoke.reject("Missing share arguments")
            return
        }

        Task { @MainActor in
            var items: [Any] = []

            if let text = args.text {
                items.append(text)
            }

            if let urlString = args.url, let url = URL(string: urlString) {
                items.append(url)
            }

            if items.isEmpty {
                invoke.reject("Nothing to share: provide text or url")
                return
            }

            let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let title = args.title {
                activityVC.setValue(title, forKey: "subject")
            }

            // For iPad, set the popover source
            if let popover = activityVC.popoverPresentationController,
               let keyWindow = UIApplication.shared.connectedScenes
                   .compactMap({ $0 as? UIWindowScene })
                   .flatMap({ $0.windows })
                   .first(where: { $0.isKeyWindow }) {
                popover.sourceView = keyWindow
                popover.sourceRect = CGRect(x: keyWindow.bounds.midX, y: keyWindow.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }

            guard let rootVC = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows })
                .first(where: { $0.isKeyWindow })?
                .rootViewController else {
                invoke.reject("No root view controller available")
                return
            }

            var topVC = rootVC
            while let presented = topVC.presentedViewController {
                topVC = presented
            }

            activityVC.completionWithItemsHandler = { _, completed, _, error in
                if let error = error {
                    invoke.reject("Share failed: \(error.localizedDescription)")
                } else {
                    invoke.resolve(["completed": completed])
                }
            }
            topVC.present(activityVC, animated: true)
        }
    }

    // Called from Tauri command: open_oauth_browser
    // Uses ASWebAuthenticationSession for proper system browser OAuth
    @objc func openOauthBrowser(_ invoke: Invoke) {
        guard let args = invoke.parseArgs(OpenBrowserArgs.self) else {
            invoke.reject("Missing url argument")
            return
        }

        guard let url = URL(string: args.url) else {
            invoke.reject("Invalid URL")
            return
        }

        Task { @MainActor in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: "ellul"
            ) { callbackURL, error in
                if let error = error {
                    if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        invoke.reject("OAuth was cancelled")
                    } else {
                        invoke.reject("OAuth failed: \(error.localizedDescription)")
                    }
                    return
                }

                guard let callbackURL = callbackURL else {
                    invoke.reject("No callback URL received")
                    return
                }

                // Return the full callback URL — the frontend will extract the exchange code
                invoke.resolve(["callbackUrl": callbackURL.absoluteString])
            }

            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = ASWebAuthContextProvider()
            session.start()
        }
    }
}

// MARK: - Argument types

struct OpenBrowserArgs: Decodable {
    let url: String
}

struct HapticFeedbackArgs: Decodable {
    let intensity: String
}

struct CopyToClipboardArgs: Decodable {
    let text: String
    let label: String?
}

struct ShareArgs: Decodable {
    let text: String?
    let title: String?
    let url: String?
}

// MARK: - ASWebAuthenticationSession context provider

class ASWebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? UIWindow()
    }
}

// MARK: - Plugin Registration

@_cdecl("init_plugin_native_auth")
func initPlugin() -> Plugin {
    return NativeAuthPlugin()
}
