import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/biometric_unlock.dart';

void main() {
  test('cold start prompts only when mobile, enabled, and a refresh token exists', () {
    expect(
      coldStartNeedsBiometric(
        mobile: true,
        enabled: true,
        refreshPresent: true,
      ),
      isTrue,
    );
    expect(
      coldStartNeedsBiometric(
        mobile: false,
        enabled: true,
        refreshPresent: true,
      ),
      isFalse,
    );
    expect(
      coldStartNeedsBiometric(
        mobile: true,
        enabled: false,
        refreshPresent: true,
      ),
      isFalse,
    );
    expect(
      coldStartNeedsBiometric(
        mobile: true,
        enabled: true,
        refreshPresent: false,
      ),
      isFalse,
    );
  });
}
