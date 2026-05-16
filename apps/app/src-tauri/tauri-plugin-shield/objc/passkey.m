#import <Foundation/Foundation.h>
#import <AuthenticationServices/AuthenticationServices.h>

#if TARGET_OS_OSX
#import <AppKit/AppKit.h>
#else
#import <UIKit/UIKit.h>
#endif

// Callback signature: (json_result, error_message, is_cancelled, context)
typedef void (*EllulPasskeyCallback)(const char *json, const char *error, int cancelled, void *ctx);

// ── Base64URL helpers ────────────────────────────────────────────

static NSData *b64url_decode(NSString *input) {
    NSMutableString *b64 = [input mutableCopy];
    [b64 replaceOccurrencesOfString:@"-" withString:@"+" options:0 range:NSMakeRange(0, b64.length)];
    [b64 replaceOccurrencesOfString:@"_" withString:@"/" options:0 range:NSMakeRange(0, b64.length)];
    while (b64.length % 4 != 0) [b64 appendString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:b64 options:0];
}

static NSString *b64url_encode(NSData *data) {
    NSString *b64 = [data base64EncodedStringWithOptions:0];
    NSMutableString *out = [b64 mutableCopy];
    [out replaceOccurrencesOfString:@"+" withString:@"-" options:0 range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@"/" withString:@"_" options:0 range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@"=" withString:@"" options:0 range:NSMakeRange(0, out.length)];
    return out;
}

// ── Delegate ─────────────────────────────────────────────────────

API_AVAILABLE(macos(13.0), ios(16.0))
@interface EllulPasskeyDelegate : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property (nonatomic) EllulPasskeyCallback callback;
@property (nonatomic) void *callbackCtx;
@property (nonatomic) BOOL settled;
@end

API_AVAILABLE(macos(13.0), ios(16.0))
@implementation EllulPasskeyDelegate

#if TARGET_OS_OSX
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
    return [NSApp keyWindow] ?: [NSApp mainWindow] ?: [[NSApp windows] firstObject];
}
#else
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
    UIWindowScene *scene = (UIWindowScene *)[[UIApplication sharedApplication].connectedScenes anyObject];
    return scene.windows.firstObject ?: [[UIWindow alloc] init];
}
#endif

- (void)authorizationController:(ASAuthorizationController *)controller
   didCompleteWithAuthorization:(ASAuthorization *)authorization {
    if (self.settled) return;
    self.settled = YES;

    NSMutableDictionary *result = [NSMutableDictionary new];
    result[@"type"] = @"public-key";

    if ([authorization.credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]]) {
        ASAuthorizationPlatformPublicKeyCredentialAssertion *a =
            (ASAuthorizationPlatformPublicKeyCredentialAssertion *)authorization.credential;

        result[@"id"] = b64url_encode(a.credentialID);
        result[@"rawId"] = b64url_encode(a.credentialID);
        result[@"authenticatorAttachment"] = @"platform";

        NSMutableDictionary *response = [NSMutableDictionary new];
        response[@"clientDataJSON"] = b64url_encode(a.rawClientDataJSON);
        response[@"authenticatorData"] = b64url_encode(a.rawAuthenticatorData);
        response[@"signature"] = b64url_encode(a.signature);
        if (a.userID) response[@"userHandle"] = b64url_encode(a.userID);
        result[@"response"] = response;

    } else if ([authorization.credential isKindOfClass:[ASAuthorizationSecurityKeyPublicKeyCredentialAssertion class]]) {
        ASAuthorizationSecurityKeyPublicKeyCredentialAssertion *a =
            (ASAuthorizationSecurityKeyPublicKeyCredentialAssertion *)authorization.credential;

        result[@"id"] = b64url_encode(a.credentialID);
        result[@"rawId"] = b64url_encode(a.credentialID);
        result[@"authenticatorAttachment"] = @"cross-platform";

        NSMutableDictionary *response = [NSMutableDictionary new];
        response[@"clientDataJSON"] = b64url_encode(a.rawClientDataJSON);
        response[@"authenticatorData"] = b64url_encode(a.rawAuthenticatorData);
        response[@"signature"] = b64url_encode(a.signature);
        if (a.userID) response[@"userHandle"] = b64url_encode(a.userID);
        result[@"response"] = response;

    } else if ([authorization.credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
        ASAuthorizationPlatformPublicKeyCredentialRegistration *r =
            (ASAuthorizationPlatformPublicKeyCredentialRegistration *)authorization.credential;

        result[@"id"] = b64url_encode(r.credentialID);
        result[@"rawId"] = b64url_encode(r.credentialID);
        result[@"authenticatorAttachment"] = @"platform";

        NSMutableDictionary *response = [NSMutableDictionary new];
        response[@"clientDataJSON"] = b64url_encode(r.rawClientDataJSON);
        response[@"attestationObject"] = b64url_encode(r.rawAttestationObject);
        result[@"response"] = response;

    } else if ([authorization.credential isKindOfClass:[ASAuthorizationSecurityKeyPublicKeyCredentialRegistration class]]) {
        ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *r =
            (ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *)authorization.credential;

        result[@"id"] = b64url_encode(r.credentialID);
        result[@"rawId"] = b64url_encode(r.credentialID);
        result[@"authenticatorAttachment"] = @"cross-platform";

        NSMutableDictionary *response = [NSMutableDictionary new];
        response[@"clientDataJSON"] = b64url_encode(r.rawClientDataJSON);
        response[@"attestationObject"] = b64url_encode(r.rawAttestationObject);
        result[@"response"] = response;
    }

    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    self.callback(json.UTF8String, NULL, 0, self.callbackCtx);
}

- (void)authorizationController:(ASAuthorizationController *)controller
           didCompleteWithError:(NSError *)error {
    if (self.settled) return;
    self.settled = YES;

    int cancelled = (error.code == ASAuthorizationErrorCanceled) ? 1 : 0;
    NSString *msg = [NSString stringWithFormat:@"%@ (code %ld)", error.localizedDescription, (long)error.code];
    self.callback(NULL, msg.UTF8String, cancelled, self.callbackCtx);
}

@end

// ── Prevent delegate dealloc during ceremony ─────────────────────

static EllulPasskeyDelegate *activeDelegate API_AVAILABLE(macos(13.0), ios(16.0)) = nil;
static ASAuthorizationController *activeController API_AVAILABLE(macos(13.0), ios(16.0)) = nil;

// ── Public C API ─────────────────────────────────────────────────

int ellul_passkey_available(void) {
    if (@available(macOS 13.0, iOS 16.0, *)) {
        return 1;
    }
    return 0;
}

void ellul_passkey_authenticate(
    const uint8_t *challenge, size_t challenge_len,
    const char *rp_id,
    const char *allow_creds_json,  // JSON array of {id: base64url} or NULL
    const char *user_verification, // "required" | "preferred" | "discouraged" | NULL
    EllulPasskeyCallback callback,
    void *ctx
) {
    if (@available(macOS 13.0, iOS 16.0, *)) {
        NSData *challengeData = [NSData dataWithBytes:challenge length:challenge_len];
        NSString *rpId = [NSString stringWithUTF8String:rp_id];

        ASAuthorizationPlatformPublicKeyCredentialProvider *platformProvider =
            [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *platformReq =
            [platformProvider createCredentialAssertionRequestWithChallenge:challengeData];

        ASAuthorizationSecurityKeyPublicKeyCredentialProvider *secKeyProvider =
            [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *secKeyReq =
            [secKeyProvider createCredentialAssertionRequestWithChallenge:challengeData];

        // Parse allowCredentials
        if (allow_creds_json) {
            NSData *jsonData = [NSData dataWithBytes:allow_creds_json length:strlen(allow_creds_json)];
            NSArray *creds = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
            if ([creds isKindOfClass:[NSArray class]] && creds.count > 0) {
                NSMutableArray *platformDescs = [NSMutableArray new];
                NSMutableArray *secKeyDescs = [NSMutableArray new];
                for (NSDictionary *cred in creds) {
                    NSString *idStr = cred[@"id"];
                    if (!idStr) continue;
                    NSData *credId = b64url_decode(idStr);
                    [platformDescs addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
                        initWithCredentialID:credId]];
                    [secKeyDescs addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc]
                        initWithCredentialID:credId transports:@[
                            ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB,
                            ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC,
                            ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth
                        ]]];
                }
                if (platformDescs.count > 0) platformReq.allowedCredentials = platformDescs;
                if (secKeyDescs.count > 0) secKeyReq.allowedCredentials = secKeyDescs;
            }
        }

        // User verification preference
        if (user_verification) {
            NSString *uv = [NSString stringWithUTF8String:user_verification];
            ASAuthorizationPublicKeyCredentialUserVerificationPreference pref =
                ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred;
            if ([uv isEqualToString:@"required"])
                pref = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
            else if ([uv isEqualToString:@"discouraged"])
                pref = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceDiscouraged;
            platformReq.userVerificationPreference = pref;
        }

        EllulPasskeyDelegate *delegate = [[EllulPasskeyDelegate alloc] init];
        delegate.callback = callback;
        delegate.callbackCtx = ctx;
        delegate.settled = NO;

        ASAuthorizationController *controller = [[ASAuthorizationController alloc]
            initWithAuthorizationRequests:@[platformReq, secKeyReq]];
        controller.delegate = delegate;
        controller.presentationContextProvider = delegate;

        activeDelegate = delegate;
        activeController = controller;

        dispatch_async(dispatch_get_main_queue(), ^{
            [controller performRequests];
        });
    } else {
        callback(NULL, "macOS 13+ / iOS 16+ required", 0, ctx);
    }
}

void ellul_passkey_register(
    const uint8_t *challenge, size_t challenge_len,
    const char *rp_id,
    const char *rp_name,
    const uint8_t *user_id, size_t user_id_len,
    const char *user_name,
    const char *user_display_name,
    const char *attestation,       // "none" | "direct" | "indirect" | NULL
    const char *user_verification, // "required" | "preferred" | "discouraged" | NULL
    EllulPasskeyCallback callback,
    void *ctx
) {
    if (@available(macOS 13.0, iOS 16.0, *)) {
        NSData *challengeData = [NSData dataWithBytes:challenge length:challenge_len];
        NSString *rpIdStr = [NSString stringWithUTF8String:rp_id];
        NSData *userIdData = [NSData dataWithBytes:user_id length:user_id_len];
        NSString *userNameStr = [NSString stringWithUTF8String:user_name];

        ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
            [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpIdStr];
        ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *request =
            [provider createCredentialRegistrationRequestWithChallenge:challengeData
                                                                 name:userNameStr
                                                               userID:userIdData];

        if (user_verification) {
            NSString *uv = [NSString stringWithUTF8String:user_verification];
            if ([uv isEqualToString:@"required"])
                request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
            else if ([uv isEqualToString:@"discouraged"])
                request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceDiscouraged;
            else
                request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred;
        }

        if (attestation) {
            NSString *att = [NSString stringWithUTF8String:attestation];
            if ([att isEqualToString:@"direct"])
                request.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindDirect;
            else if ([att isEqualToString:@"indirect"])
                request.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindIndirect;
            else
                request.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindNone;
        }

        EllulPasskeyDelegate *delegate = [[EllulPasskeyDelegate alloc] init];
        delegate.callback = callback;
        delegate.callbackCtx = ctx;
        delegate.settled = NO;

        ASAuthorizationController *controller = [[ASAuthorizationController alloc]
            initWithAuthorizationRequests:@[request]];
        controller.delegate = delegate;
        controller.presentationContextProvider = delegate;

        activeDelegate = delegate;
        activeController = controller;

        dispatch_async(dispatch_get_main_queue(), ^{
            [controller performRequests];
        });
    } else {
        callback(NULL, "macOS 13+ / iOS 16+ required", 0, ctx);
    }
}

void ellul_passkey_cancel(void) {
    if (@available(macOS 13.0, iOS 16.0, *)) {
        if (activeController) {
            [activeController cancel];
        }
    }
}
