import '../utils/activity_time.dart';

String _text(dynamic value) {
  if (value == null) return '';
  return value.toString();
}

DateTime? _instant(dynamic value) {
  if (value == null) return null;
  final text = value.toString().trim();
  if (text.isEmpty) return null;
  return DateTime.tryParse(text);
}

/// One accepted member, pending invitation, or declined invitation from
/// GET /api/plans/:planId/members.
class PlanMember {
  final String name;
  final String email;
  final String role;
  final String status;
  final DateTime? invitedAt;
  final DateTime? lastActivityAt;

  const PlanMember({
    required this.name,
    required this.email,
    required this.role,
    required this.status,
    this.invitedAt,
    this.lastActivityAt,
  });

  factory PlanMember.fromJson(Map<String, dynamic> json) {
    return PlanMember(
      name: _text(json['name']),
      email: _text(json['email']),
      role: _text(json['role']),
      status: _text(json['status']),
      invitedAt: _instant(json['invitedAt']),
      lastActivityAt: _instant(json['lastActivityAt']),
    );
  }
}

String _twoDigit(int value) => value.toString().padLeft(2, '0');

/// Clock for a people row. A plan zone uses that IANA name. An empty plan
/// zone uses [deviceTimeZone], then the device clock.
String planMemberClock(
  DateTime instant, {
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  final plan = planTimeZone.trim();
  if (plan.isNotEmpty) {
    return '${itineraryClockLabel(instant, plan)} ${zoneDaylightLabel(instant, plan)}';
  }
  final device = (deviceTimeZone ?? '').trim();
  if (device.isNotEmpty) {
    return '${itineraryClockLabel(instant, device)} ${zoneDaylightLabel(instant, device)}';
  }
  final local = instant.toLocal();
  final clock = '${local.month}/${local.day} ${_twoDigit(local.hour)}:${_twoDigit(local.minute)}';
  final name = local.timeZoneName.trim();
  if (name.isEmpty) return clock;
  return '$clock $name';
}

/// Pending shows the latest invite. Declined shows the declined time.
/// Accepted shows the newest activity revision on this plan, or
/// "no activity yet". Clocks use the plan time zone.
String planMemberTimeLine(
  PlanMember member,
  String planTimeZone, {
  String? deviceTimeZone,
}) {
  final status = member.status.trim().toLowerCase();
  if (status == 'accepted') {
    final instant = member.lastActivityAt;
    if (instant == null) return 'no activity yet';
    final clock = planMemberClock(
      instant,
      planTimeZone: planTimeZone,
      deviceTimeZone: deviceTimeZone,
    );
    return 'Last activity $clock';
  }

  final String label;
  final DateTime? instant;
  if (status == 'pending') {
    label = 'Invited';
    instant = member.invitedAt;
  } else if (status == 'rejected' || status == 'declined') {
    label = 'Declined';
    instant = member.invitedAt;
  } else {
    return '';
  }
  if (instant == null) return label;
  return '$label ${planMemberClock(instant, planTimeZone: planTimeZone, deviceTimeZone: deviceTimeZone)}';
}

bool _isStoredOwner(String role) {
  switch (role.trim().toLowerCase()) {
    case 'owner':
    case 'vibecoordinator':
      return true;
    default:
      return false;
  }
}

bool _isAcceptedMember(PlanMember member) {
  return member.status.trim().toLowerCase() == 'accepted';
}

bool _isCollaboratorRole(String role) {
  switch (role.trim().toLowerCase()) {
    case 'collaborator':
    case 'vibeplanner':
      return true;
    default:
      return false;
  }
}

/// Accepted owner, then accepted co-planners. Pending people, guests, and
/// attendees are left out. An empty email is left out.
List<PlanMember> linkedPlanPlanners(List<PlanMember> members) {
  final owners = <PlanMember>[];
  final planners = <PlanMember>[];
  for (final member in members) {
    if (!_isAcceptedMember(member) || member.email.trim().isEmpty) continue;
    if (_isStoredOwner(member.role)) {
      owners.add(member);
    } else if (_isCollaboratorRole(member.role)) {
      planners.add(member);
    }
  }
  return [...owners, ...planners];
}

/// Owner once at the top, then accepted, pending, and declined people.
List<PlanMember> peopleScreenMembers(List<PlanMember> members) {
  PlanMember? owner;
  final rest = <PlanMember>[];
  for (final member in members) {
    if (_isStoredOwner(member.role)) {
      owner ??= member;
    } else {
      rest.add(member);
    }
  }
  return [?owner, ...rest];
}
