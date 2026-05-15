#import <AuthenticationServices/AuthenticationServices.h>
#import <AppKit/AppKit.h>
#include "passkey.h"

static NSData *b64url_decode(NSString *str) {
    NSMutableString *b64 = [str mutableCopy];
    [b64 replaceOccurrencesOfString:@"-" withString:@"+" options:0 range:NSMakeRange(0, b64.length)];
    [b64 replaceOccurrencesOfString:@"_" withString:@"/" options:0 range:NSMakeRange(0, b64.length)];
    while (b64.length % 4 != 0) [b64 appendString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:b64 options:0];
}

static NSString *b64url_encode(NSData *data) {
    NSString *b64 = [data base64EncodedStringWithOptions:0];
    b64 = [b64 stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
    b64 = [b64 stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
    b64 = [b64 stringByReplacingOccurrencesOfString:@"=" withString:@""];
    return b64;
}

@interface EllulPasskeyDelegate : NSObject
    <ASAuthorizationControllerDelegate,
     ASAuthorizationControllerPresentationContextProviding>
@property (nonatomic, assign) EllulPasskeyCallback callback;
@property (nonatomic, assign) void *context;
@end

@implementation EllulPasskeyDelegate

- (ASPresentationAnchor)presentationAnchorForAuthorizationController:
    (ASAuthorizationController *)controller {
    return [NSApp keyWindow] ?: [NSApp mainWindow];
}

- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithAuthorization:(ASAuthorization *)authorization {

    NSData *jsonData = nil;

    if ([authorization.credential isKindOfClass:
            [ASAuthorizationPlatformPublicKeyCredentialAssertion class]]) {
        ASAuthorizationPlatformPublicKeyCredentialAssertion *a =
            (ASAuthorizationPlatformPublicKeyCredentialAssertion *)authorization.credential;

        NSDictionary *resp = @{
            @"id": b64url_encode(a.credentialID),
            @"rawId": b64url_encode(a.credentialID),
            @"type": @"public-key",
            @"response": @{
                @"authenticatorData": b64url_encode(a.rawAuthenticatorData),
                @"clientDataJSON": b64url_encode(a.rawClientDataJSON),
                @"signature": b64url_encode(a.signature),
                @"userHandle": a.userID ? b64url_encode(a.userID) : @"",
            },
            @"authenticatorAttachment": @"platform",
            @"clientExtensionResults": @{},
        };
        jsonData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];

    } else if ([authorization.credential isKindOfClass:
            [ASAuthorizationSecurityKeyPublicKeyCredentialAssertion class]]) {
        ASAuthorizationSecurityKeyPublicKeyCredentialAssertion *a =
            (ASAuthorizationSecurityKeyPublicKeyCredentialAssertion *)authorization.credential;

        NSDictionary *resp = @{
            @"id": b64url_encode(a.credentialID),
            @"rawId": b64url_encode(a.credentialID),
            @"type": @"public-key",
            @"response": @{
                @"authenticatorData": b64url_encode(a.rawAuthenticatorData),
                @"clientDataJSON": b64url_encode(a.rawClientDataJSON),
                @"signature": b64url_encode(a.signature),
                @"userHandle": a.userID ? b64url_encode(a.userID) : @"",
            },
            @"authenticatorAttachment": @"cross-platform",
            @"clientExtensionResults": @{},
        };
        jsonData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];

    } else if ([authorization.credential isKindOfClass:
            [ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
        ASAuthorizationPlatformPublicKeyCredentialRegistration *r =
            (ASAuthorizationPlatformPublicKeyCredentialRegistration *)authorization.credential;

        NSDictionary *resp = @{
            @"id": b64url_encode(r.credentialID),
            @"rawId": b64url_encode(r.credentialID),
            @"type": @"public-key",
            @"response": @{
                @"attestationObject": b64url_encode(r.rawAttestationObject),
                @"clientDataJSON": b64url_encode(r.rawClientDataJSON),
            },
            @"authenticatorAttachment": @"platform",
            @"clientExtensionResults": @{},
        };
        jsonData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
    }

    if (jsonData) {
        self.callback(self.context, jsonData.bytes, jsonData.length, NULL);
    } else {
        self.callback(self.context, NULL, 0, "Unexpected credential type");
    }
}

- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithError:(NSError *)error {
    self.callback(self.context, NULL, 0, error.localizedDescription.UTF8String);
}

@end

static EllulPasskeyDelegate *_active = nil;

void ellul_passkey_authenticate(
    const uint8_t *challenge, size_t challenge_len,
    const char *rp_id,
    EllulPasskeyCallback callback,
    void *context
) {
    NSData *challengeData = [NSData dataWithBytes:challenge length:challenge_len];
    NSString *rpId = [NSString stringWithUTF8String:rp_id];

    // Platform provider: iCloud Keychain, 3rd-party managers, cross-device QR
    ASAuthorizationPlatformPublicKeyCredentialProvider *platform =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
            initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *platformReq =
        [platform createCredentialAssertionRequestWithChallenge:challengeData];

    // Security key provider: hardware FIDO2 keys (YubiKey etc.)
    ASAuthorizationSecurityKeyPublicKeyCredentialProvider *secKey =
        [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc]
            initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *secKeyReq =
        [secKey createCredentialAssertionRequestWithChallenge:challengeData];

    ASAuthorizationController *ctrl =
        [[ASAuthorizationController alloc]
            initWithAuthorizationRequests:@[platformReq, secKeyReq]];

    EllulPasskeyDelegate *d = [[EllulPasskeyDelegate alloc] init];
    d.callback = callback;
    d.context = context;
    _active = d;

    ctrl.delegate = d;
    ctrl.presentationContextProvider = d;

    dispatch_async(dispatch_get_main_queue(), ^{
        [ctrl performRequests];
    });
}

void ellul_passkey_register(
    const uint8_t *challenge, size_t challenge_len,
    const char *rp_id,
    const uint8_t *user_id, size_t user_id_len,
    const char *user_name,
    const char *user_display_name,
    EllulPasskeyCallback callback,
    void *context
) {
    NSData *challengeData = [NSData dataWithBytes:challenge length:challenge_len];
    NSString *rpId = [NSString stringWithUTF8String:rp_id];
    NSData *userId = [NSData dataWithBytes:user_id length:user_id_len];
    NSString *name = [NSString stringWithUTF8String:user_name];

    ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
            initWithRelyingPartyIdentifier:rpId];

    ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *req =
        [provider createCredentialRegistrationRequestWithChallenge:challengeData
            name:name userID:userId];

    ASAuthorizationController *ctrl =
        [[ASAuthorizationController alloc] initWithAuthorizationRequests:@[req]];

    EllulPasskeyDelegate *d = [[EllulPasskeyDelegate alloc] init];
    d.callback = callback;
    d.context = context;
    _active = d;

    ctrl.delegate = d;
    ctrl.presentationContextProvider = d;

    dispatch_async(dispatch_get_main_queue(), ^{
        [ctrl performRequests];
    });
}
