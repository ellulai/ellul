import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '{{PROJECT_NAME}}',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF171717)),
      home: const Scaffold(
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('ellul', style: TextStyle(letterSpacing: 4, fontSize: 12)),
              SizedBox(height: 16),
              Text('Your app is ready.', style: TextStyle(fontSize: 32, fontWeight: FontWeight.w600)),
              SizedBox(height: 8),
              Text(
                'Ask the agent to build, or edit this page to start shipping.',
                style: TextStyle(fontSize: 14),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
