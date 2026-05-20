#import <Foundation/Foundation.h>

#if TARGET_OS_OSX || TARGET_OS_IOS
#import <WebKit/WebKit.h>

// Callback type: Rust function called when __Host-shield_session changes
typedef void (*EllulCookieChangeCallback)(const char *domain, const char *new_value, void *ctx);

// Observer that watches WKHTTPCookieStore for shield session cookie changes
@interface EllulCookieObserver : NSObject <WKHTTPCookieStoreObserver>
@property (nonatomic) WKHTTPCookieStore *store;
@property (nonatomic) EllulCookieChangeCallback callback;
@property (nonatomic) void *callbackCtx;
@end

@implementation EllulCookieObserver

- (void)cookiesDidChangeInCookieStore:(WKHTTPCookieStore *)cookieStore {
    if (!self.callback) return;
    EllulCookieChangeCallback cb = self.callback;
    void *ctx = self.callbackCtx;
    [cookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
        for (NSHTTPCookie *c in cookies) {
            if ([c.name isEqualToString:@"__Host-shield_session"] &&
                [c.domain hasSuffix:@"-srv.ellul.ai"]) {
                NSLog(@"[ellul-cookie] observed change: %@ domain=%@ val=%@...",
                      c.name, c.domain,
                      [c.value substringToIndex:MIN(c.value.length, 16)]);
                const char *d = [c.domain UTF8String];
                const char *v = [c.value UTF8String];
                cb(d, v, ctx);
                break;
            }
        }
    }];
}

@end

static EllulCookieObserver *_observer = nil;

void ellul_clear_http_cache_and_reload(void *wk_webview_ptr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKWebsiteDataStore *store = webview.configuration.websiteDataStore;
        NSSet *types = [NSSet setWithArray:@[
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
        ]];
        [store removeDataOfTypes:types
                   modifiedSince:[NSDate distantPast]
               completionHandler:^{
            NSLog(@"[ellul-cookie] HTTP cache cleared → reloading");
            dispatch_async(dispatch_get_main_queue(), ^{
                [webview reload];
            });
        }];
    });
}

void ellul_disable_itp(void *wk_webview_ptr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKWebsiteDataStore *store = webview.configuration.websiteDataStore;
        SEL sel = NSSelectorFromString(@"_setResourceLoadStatisticsEnabled:");
        if ([store respondsToSelector:sel]) {
            NSInvocation *inv = [NSInvocation invocationWithMethodSignature:
                [store methodSignatureForSelector:sel]];
            inv.selector = sel;
            inv.target = store;
            BOOL no = NO;
            [inv setArgument:&no atIndex:2];
            [inv invoke];
            NSLog(@"[ellul-cookie] ITP disabled on WKWebsiteDataStore");
        } else {
            NSLog(@"[ellul-cookie] WARN: ITP disable selector not available");
        }

    });
}

void ellul_inject_session_cookie(void *wk_webview_ptr,
                                  const char *cookie_value_c,
                                  const char *domain_c) {
    NSString *value = [[NSString alloc] initWithUTF8String:cookie_value_c];
    NSString *domain = [[NSString alloc] initWithUTF8String:domain_c];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
            WKHTTPCookieStore *store = webview.configuration.websiteDataStore.httpCookieStore;

            [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
                dispatch_group_t delGroup = dispatch_group_create();
                for (NSHTTPCookie *c in cookies) {
                    if ([c.name isEqualToString:@"__Host-shield_session"] &&
                        [c.domain isEqualToString:domain]) {
                        NSLog(@"[ellul-cookie] deleting stale %@ for %@ val=%@...",
                              c.name, c.domain,
                              [c.value substringToIndex:MIN(c.value.length, 8)]);
                        dispatch_group_enter(delGroup);
                        [store deleteCookie:c completionHandler:^{
                            dispatch_group_leave(delGroup);
                        }];
                    }
                }
                dispatch_group_notify(delGroup, dispatch_get_main_queue(), ^{
                    NSString *header = [NSString stringWithFormat:
                        @"__Host-shield_session=%@; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400",
                        value];
                    NSURL *url = [NSURL URLWithString:
                        [NSString stringWithFormat:@"https://%@/", domain]];

                    NSArray<NSHTTPCookie *> *newCookies =
                        [NSHTTPCookie cookiesWithResponseHeaderFields:@{@"Set-Cookie": header}
                                                              forURL:url];
                    if (newCookies.count == 0) {
                        NSLog(@"[ellul-cookie] WARN: no cookie parsed for %@", domain);
                        dispatch_semaphore_signal(done);
                        return;
                    }
                    NSHTTPCookie *cookie = newCookies[0];
                    NSLog(@"[ellul-cookie] injecting %@ for %@ sameSite=%@ secure=%d httpOnly=%d val=%@...",
                          cookie.name, domain, cookie.sameSitePolicy ?: @"(nil)",
                          cookie.isSecure, cookie.isHTTPOnly,
                          [cookie.value substringToIndex:MIN(cookie.value.length, 8)]);
                    [store setCookie:cookie completionHandler:^{
                        NSLog(@"[ellul-cookie] done: %@ for %@", cookie.name, domain);
                        dispatch_semaphore_signal(done);
                    }];
                });
            }];
        }
    });
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
}

void ellul_observe_cookie_changes(void *wk_webview_ptr,
                                   EllulCookieChangeCallback callback,
                                   void *ctx) {
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKHTTPCookieStore *store = webview.configuration.websiteDataStore.httpCookieStore;

        if (_observer) {
            [_observer.store removeObserver:_observer];
        }
        _observer = [[EllulCookieObserver alloc] init];
        _observer.store = store;
        _observer.callback = callback;
        _observer.callbackCtx = ctx;
        [store addObserver:_observer];
        NSLog(@"[ellul-cookie] observer registered");
    });
}

void ellul_scan_existing_session(void *wk_webview_ptr,
                                  EllulCookieChangeCallback callback,
                                  void *ctx) {
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKHTTPCookieStore *store = webview.configuration.websiteDataStore.httpCookieStore;
        [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
            for (NSHTTPCookie *c in cookies) {
                if ([c.name isEqualToString:@"__Host-shield_session"] &&
                    [c.domain hasSuffix:@"-srv.ellul.ai"]) {
                    NSLog(@"[ellul-cookie] scan: found existing session for %@ val=%@...",
                          c.domain,
                          [c.value substringToIndex:MIN(c.value.length, 16)]);
                    const char *d = [c.domain UTF8String];
                    const char *v = [c.value UTF8String];
                    callback(d, v, ctx);
                    return;
                }
            }
            NSLog(@"[ellul-cookie] scan: no existing __Host-shield_session found");
        }];
    });
}

void ellul_dump_cookies(void *wk_webview_ptr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
            WKHTTPCookieStore *store = webview.configuration.websiteDataStore.httpCookieStore;
            [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
                NSLog(@"[ellul-cookie] === cookie store (%lu cookies) ===",
                      (unsigned long)cookies.count);
                for (NSHTTPCookie *c in cookies) {
                    NSLog(@"[ellul-cookie]   %@ = %@... domain=%@ path=%@ secure=%d httpOnly=%d sameSite=%@",
                          c.name,
                          [c.value substringToIndex:MIN(c.value.length, 16)],
                          c.domain, c.path, c.isSecure, c.isHTTPOnly,
                          c.sameSitePolicy ?: @"(nil)");
                }
            }];
        }
    });
}

#endif
