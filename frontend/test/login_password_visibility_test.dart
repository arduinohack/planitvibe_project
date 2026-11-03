import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:planitvibe_frontend/providers/user_provider.dart';
import 'package:planitvibe_frontend/screens/login_screen.dart';

void main() {
  testWidgets('the login password starts hidden and the icon toggles it', (
    tester,
  ) async {
    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => UserProvider(),
        child: const MaterialApp(home: LoginScreen()),
      ),
    );

    TextField passwordField() {
      return tester.widget<TextField>(
        find.ancestor(
          of: find.byIcon(Icons.lock),
          matching: find.byType(TextField),
        ),
      );
    }

    expect(passwordField().obscureText, isTrue);
    expect(find.byIcon(Icons.visibility), findsOneWidget);

    await tester.tap(find.byTooltip('Show password'));
    await tester.pump();

    expect(passwordField().obscureText, isFalse);
    expect(find.byIcon(Icons.visibility_off), findsOneWidget);

    await tester.tap(find.byTooltip('Hide password'));
    await tester.pump();

    expect(passwordField().obscureText, isTrue);
    expect(find.byIcon(Icons.visibility), findsOneWidget);
  });
}
