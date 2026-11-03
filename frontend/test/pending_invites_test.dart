import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/providers/invitation_provider.dart';

void main() {
  test('an empty pending array stays on the plan list', () {
    expect(pendingInviteArrayHasItems([]), isFalse);
  });

  test('a pending array opens the invite inbox', () {
    expect(
      pendingInviteArrayHasItems([
        {'_id': 'invite-1', 'status': 'pending'},
      ]),
      isTrue,
    );
  });

  test('a non-array body does not open the inbox', () {
    expect(pendingInviteArrayHasItems({'invites': []}), isFalse);
    expect(pendingInviteArrayHasItems(null), isFalse);
  });
}
