#import <Foundation/Foundation.h>

#if TARGET_OS_OSX
#import <WebKit/WebKit.h>

static NSString *const POP_MARKER = @"__ELLUL_POP_SEED__";

void ellul_inject_pop_stub_script(void *wk_webview_ptr) {
    NSString *source = @"(function(){"
        "var _f=window.fetch;"
        "window.fetch=function(u,o){"
            "var s=(typeof u==='string')?u:(u&&u.url?u.url:String(u));"
            "if(s.indexOf('/_auth/pop/bind/init')!==-1){"
                "return Promise.resolve(new Response("
                    "JSON.stringify({bound:false,error:'tauri_pre_auth'}),"
                    "{status:401,headers:{'Content-Type':'application/json'}}"
                "));"
            "}"
            "return _f.apply(this,arguments);"
        "};"
    "})();";
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKUserContentController *ctrl = webview.configuration.userContentController;
        WKUserScript *stub = [[WKUserScript alloc]
            initWithSource:source
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:NO];
        [ctrl addUserScript:stub];
        NSLog(@"[ellul-pop] injected PoP stub (bind/init intercept, forMainFrameOnly=NO)");
    });
}

void ellul_inject_pop_user_script(void *wk_webview_ptr, const char *js_source_c) {
    NSString *source = [[NSString alloc] initWithUTF8String:js_source_c];
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *webview = (__bridge WKWebView *)wk_webview_ptr;
        WKUserContentController *ctrl = webview.configuration.userContentController;

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
        [webview evaluateJavaScript:
            @"try{var r=indexedDB.open('sovereign-shield',2);"
             "r.onsuccess=function(){var db=r.result;"
             "try{var tx=db.transaction('session-keys','readwrite');"
             "var s=tx.objectStore('session-keys');"
             "s.delete('current');s.delete('device-id');"
             "}catch(e){}}}catch(e){}"
            completionHandler:nil];
        NSLog(@"[ellul-pop] cleared PoP seed from IndexedDB");
    });
}

#endif
