import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/jwt_expiry.dart';

String _tokenWithPayload(Map<String, Object> payload) {
  String part(String jsonText) {
    return base64Url.encode(utf8.encode(jsonText)).replaceAll('=', '');
  }

  return '${part('{"alg":"none"}')}.${part(jsonEncode(payload))}.sig';
}

void main() {
  final now = DateTime.utc(2026, 10, 20, 12);

  test('a future exp is still valid', () {
    final token = _tokenWithPayload({'exp': 2000000000});
    expect(jwtIsExpired(token, now), isFalse);
    expect(jwtExpiryUtc(token), DateTime.utc(2033, 5, 18, 3, 33, 20));
  });

  test('an exp at or before now is expired', () {
    final atNow = now.millisecondsSinceEpoch ~/ 1000;
    expect(jwtIsExpired(_tokenWithPayload({'exp': atNow}), now), isTrue);
    expect(jwtIsExpired(_tokenWithPayload({'exp': atNow - 1}), now), isTrue);
  });

  test('a missing or unreadable exp is expired', () {
    expect(jwtIsExpired(_tokenWithPayload({'userId': 'a'}), now), isTrue);
    expect(jwtIsExpired('not-a-jwt', now), isTrue);
    expect(jwtExpiryUtc('not-a-jwt'), isNull);
  });
}
