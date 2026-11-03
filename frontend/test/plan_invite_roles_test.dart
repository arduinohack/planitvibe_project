import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/plan_member.dart';
import 'package:planitvibe_frontend/models/plan_role_label.dart';

void main() {
  test('Owner can send Collaborator and Guest; Collaborator can send Guest', () {
    expect(inviteStoredRoles('Owner'), ['Collaborator', 'Guest']);
    expect(inviteStoredRoles('Collaborator'), ['Guest']);
    expect(inviteStoredRoles('Guest'), isEmpty);
  });

  test('trip labels stay off the POST body', () {
    expect(planRoleLabel('trip', 'Collaborator'), 'Co-Planner');
    expect(planRoleLabel('trip', 'Guest'), 'PlanItVibe Guest');
  });

  test('plan labels stay off the POST body', () {
    expect(planRoleLabel('plan', 'Collaborator'), 'Planner');
    expect(planRoleLabel('plan', 'Guest'), 'PlanItVibe Guest');
  });

  test('a guest is labeled PlanItVibe Guest', () {
    expect(planRoleLabel('plan', 'Guest'), 'PlanItVibe Guest');
    expect(planRoleLabel('plan', 'Collaborator'), 'Planner');
    expect(planRoleLabel('trip', 'Guest'), 'PlanItVibe Guest');
    expect(planRoleLabel('trip', 'Collaborator'), 'Co-Planner');
  });

  test('trip people list uses trip labels and Pending', () {
    expect(planMemberRoleLine('trip', 'Owner', 'accepted'), 'Organizer');
    expect(planMemberRoleLine('trip', 'Collaborator', 'accepted'), 'Co-Planner');
    expect(planMemberRoleLine('trip', 'Guest', 'accepted'), 'PlanItVibe Guest');
    expect(planMemberRoleLine('trip', 'Collaborator', 'pending'), 'Co-Planner Pending');
    expect(planMemberRoleLine('trip', 'Guest', 'pending'), 'PlanItVibe Guest Pending');
  });

  test('plan people list uses plan labels and Pending', () {
    expect(planMemberRoleLine('plan', 'Owner', 'accepted'), 'Host');
    expect(planMemberRoleLine('plan', 'Collaborator', 'accepted'), 'Planner');
    expect(planMemberRoleLine('plan', 'Guest', 'accepted'), 'PlanItVibe Guest');
    expect(planMemberRoleLine('plan', 'Collaborator', 'pending'), 'Planner Pending');
    expect(planMemberRoleLine('plan', 'Guest', 'pending'), 'PlanItVibe Guest Pending');
  });

  test('only the Owner can assign an accepted Co-Planner or Planner', () {
    expect(canAssignAsOwner('Owner', 'Collaborator', 'accepted'), isTrue);
    expect(canAssignAsOwner('Owner', 'VibePlanner', 'accepted'), isTrue);
    expect(canAssignAsOwner('Owner', 'Collaborator', 'pending'), isFalse);
    expect(canAssignAsOwner('Owner', 'Guest', 'accepted'), isFalse);
    expect(canAssignAsOwner('Collaborator', 'Collaborator', 'accepted'), isFalse);
    expect(canAssignAsOwner('Guest', 'Collaborator', 'accepted'), isFalse);
  });

  test('Owner may remove Collaborator or Guest; Collaborator may remove Guest', () {
    expect(canRemoveStoredRole('Owner', 'Collaborator'), isTrue);
    expect(canRemoveStoredRole('Owner', 'Guest'), isTrue);
    expect(canRemoveStoredRole('Owner', 'Owner'), isFalse);
    expect(canRemoveStoredRole('Collaborator', 'Guest'), isTrue);
    expect(canRemoveStoredRole('Collaborator', 'Collaborator'), isFalse);
    expect(canRemoveStoredRole('Collaborator', 'Owner'), isFalse);
    expect(canRemoveStoredRole('Guest', 'Guest'), isFalse);
    expect(canRemoveStoredRole('Guest', 'Collaborator'), isFalse);
  });

  test('people screen lists the Owner once at the top', () {
    const extraOwner = PlanMember(
      name: 'Other',
      email: 'other@example.com',
      role: 'Owner',
      status: 'accepted',
    );
    const owner = PlanMember(
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'Owner',
      status: 'accepted',
    );
    const collaborator = PlanMember(
      name: 'Grace Hopper',
      email: 'grace@example.com',
      role: 'Collaborator',
      status: 'accepted',
    );
    const pendingGuest = PlanMember(
      name: '',
      email: 'new.person@example.com',
      role: 'Guest',
      status: 'pending',
    );
    final listed = peopleScreenMembers([
      collaborator,
      extraOwner,
      pendingGuest,
      owner,
    ]);
    expect(listed, [extraOwner, collaborator, pendingGuest]);
    expect(listed.first.role, 'Owner');
    expect(listed.where((row) => row.role == 'Owner'), hasLength(1));
  });

  test('a linked plan lists the owner and co-planners only', () {
    const owner = PlanMember(
      name: 'Ada',
      email: 'ada@example.com',
      role: 'Owner',
      status: 'accepted',
    );
    const planner = PlanMember(
      name: 'Grace',
      email: 'grace@example.com',
      role: 'Collaborator',
      status: 'accepted',
    );
    const legacyPlanner = PlanMember(
      name: 'Ken',
      email: 'ken@example.com',
      role: 'VibePlanner',
      status: 'accepted',
    );
    const guest = PlanMember(
      name: 'Alan',
      email: 'alan@example.com',
      role: 'Guest',
      status: 'accepted',
    );
    const attendee = PlanMember(
      name: 'Mary',
      email: 'mary@example.com',
      role: 'Wanderer',
      status: 'accepted',
    );
    const pending = PlanMember(
      name: '',
      email: 'pending@example.com',
      role: 'Collaborator',
      status: 'pending',
    );
    const declined = PlanMember(
      name: 'No',
      email: 'no@example.com',
      role: 'Collaborator',
      status: 'rejected',
      invitedAt: null,
    );
    const blank = PlanMember(
      name: 'No Mail',
      email: '   ',
      role: 'Collaborator',
      status: 'accepted',
    );

    final listed = linkedPlanPlanners([
      planner,
      guest,
      pending,
      declined,
      owner,
      attendee,
      legacyPlanner,
      blank,
    ]);

    expect(listed, [owner, planner, legacyPlanner]);
    expect(planRoleLabel('trip', listed[0].role), 'Organizer');
    expect(planRoleLabel('trip', listed[1].role), 'Co-Planner');
    expect(planRoleLabel('plan', listed[0].role), 'Host');
    expect(planRoleLabel('plan', listed[2].role), 'Planner');
  });

  test('people times use the plan zone', () {
    final winter = DateTime.parse('2026-01-15T17:00:00Z');
    final summer = DateTime.parse('2026-07-15T16:00:00Z');
    final pending = PlanMember(
      name: 'Eve',
      email: 'eve@example.com',
      role: 'Guest',
      status: 'pending',
      invitedAt: winter,
    );
    final declined = PlanMember(
      name: 'Grace',
      email: 'grace@example.com',
      role: 'Collaborator',
      status: 'rejected',
      invitedAt: winter,
    );
    final accepted = PlanMember(
      name: 'Ada',
      email: 'ada@example.com',
      role: 'Owner',
      status: 'accepted',
      lastActivityAt: summer,
    );
    final quiet = PlanMember(
      name: 'Alan',
      email: 'alan@example.com',
      role: 'Guest',
      status: 'accepted',
    );

    expect(
      planMemberTimeLine(pending, 'America/New_York'),
      'Invited 1/15 12:00 Eastern ST',
    );
    expect(
      planMemberTimeLine(declined, 'America/New_York'),
      'Declined 1/15 12:00 Eastern ST',
    );
    expect(
      planMemberTimeLine(accepted, 'America/New_York'),
      'Last activity 7/15 12:00 Eastern DT',
    );
    expect(
      planMemberTimeLine(accepted, 'UTC'),
      'Last activity 7/15 16:00 UTC',
    );
    expect(
      planMemberTimeLine(accepted, '', deviceTimeZone: 'America/Chicago'),
      'Last activity 7/15 11:00 Central DT',
    );
    expect(planMemberTimeLine(quiet, 'America/New_York'), 'no activity yet');
  });

  test('an empty plan zone uses the device clock', () {
    final instant = DateTime.parse('2026-01-15T17:00:00Z');
    final local = instant.toLocal();
    final hour = local.hour.toString().padLeft(2, '0');
    final minute = local.minute.toString().padLeft(2, '0');
    final member = PlanMember(
      name: 'Ada',
      email: 'ada@example.com',
      role: 'Owner',
      status: 'accepted',
      lastActivityAt: instant,
    );
    expect(
      planMemberTimeLine(member, '   '),
      startsWith('Last activity ${local.month}/${local.day} $hour:$minute'),
    );
  });

  test('member times parse from the members payload', () {
    final pending = PlanMember.fromJson({
      'name': 'Eve',
      'email': 'eve@example.com',
      'role': 'Guest',
      'status': 'pending',
      'invitedAt': '2026-01-15T17:00:00.000Z',
    });
    final accepted = PlanMember.fromJson({
      'name': 'Ada',
      'email': 'ada@example.com',
      'role': 'Owner',
      'status': 'accepted',
      'lastActivityAt': '2026-07-15T16:00:00.000Z',
    });
    expect(pending.invitedAt, DateTime.parse('2026-01-15T17:00:00.000Z'));
    expect(pending.lastActivityAt, isNull);
    expect(accepted.lastActivityAt, DateTime.parse('2026-07-15T16:00:00.000Z'));
    expect(accepted.invitedAt, isNull);
  });
}
