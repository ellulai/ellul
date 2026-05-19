#import <Foundation/Foundation.h>

#if TARGET_OS_OSX
#import <WebKit/WebKit.h>

static NSString *const POP_MARKER = @"__ELLUL_POP_SEED__";

void ellul_inject_pop_user_script(void *wk_webview_ptr, const char *js_source_c) {
    NSString *source = [[NSString alloc] initWithUTF8String:js_source_c];
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKUserContentController *ctrl = webview.configuration.userContentController;

        NSArray<WKUserScript *> *existing = [ctrl.userScripts copy];
        [ctrl removeAllUserScripts];
        for (WKUserScript *s in existing) {
            if (![s.source containsString:POP_MARKER]) {
                [ctrl addUserScript:s];
            }
        }

        WKUserScript *popScript = [[WKUserScript alloc]
            initWithSource:source
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:NO];
        [ctrl addUserScript:popScript];
        NSLog(@"[ellul-pop] injected PoP seed user script (forMainFrameOnly=NO)");
    });
}

void ellul_remove_pop_user_scripts(void *wk_webview_ptr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKUserContentController *ctrl = webview.configuration.userContentController;

        NSArray<WKUserScript *> *existing = [ctrl.userScripts copy];
        BOOL found = NO;
        for (WKUserScript *s in existing) {
            if ([s.source containsString:POP_MARKER]) { found = YES; break; }
        }
        if (!found) return;

        [ctrl removeAllUserScripts];
        for (WKUserScript *s in existing) {
            if (![s.source containsString:POP_MARKER]) {
                [ctrl addUserScript:s];
            }
        }
        NSLog(@"[ellul-pop] removed PoP seed user scripts");
    });
}

#endif
