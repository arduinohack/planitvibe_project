import '../models/user.dart'; // Add this line for User class in participants
import '../utils/activity_time.dart';
import 'activity.dart';

String _twoDigitDatePart(int value) => value.toString().padLeft(2, '0');

String _ymd(int year, int month, int day) {
  return '${year.toString().padLeft(4, '0')}-${_twoDigitDatePart(month)}-${_twoDigitDatePart(day)}';
}

/// UTC calendar date from a plan field. Null stays "not set".
String formatPlanDate(DateTime? value) {
  if (value == null) return 'not set';
  final utc = value.toUtc();
  return _ymd(utc.year, utc.month, utc.day);
}

/// Calendar day of [instant] in [planTimeZone]. Empty zone uses [deviceTimeZone],
/// then the device local zone.
String formatPlanHeaderDate(
  DateTime instant, {
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  final plan = planTimeZone.trim();
  final zone = plan.isNotEmpty ? plan : (deviceTimeZone ?? '').trim();
  if (zone.isEmpty) {
    final local = instant.toLocal();
    return _ymd(local.year, local.month, local.day);
  }
  final clock = clockInZone(instant, zone);
  return _ymd(clock.year, clock.month, clock.day);
}

/// Date line from a precomputed activity span. Null when [earliestStart] is null.
/// Same calendar day in the plan zone is one date. Empty plan zone uses the device zone.
String? planSpanDateLine({
  DateTime? earliestStart,
  DateTime? latestEnd,
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  if (earliestStart == null) return null;
  final startLabel = formatPlanHeaderDate(
    earliestStart,
    planTimeZone: planTimeZone,
    deviceTimeZone: deviceTimeZone,
  );
  final endLabel = formatPlanHeaderDate(
    latestEnd ?? earliestStart,
    planTimeZone: planTimeZone,
    deviceTimeZone: deviceTimeZone,
  );
  if (startLabel == endLabel) return 'Dates: $startLabel';
  return 'Dates: $startLabel - $endLabel';
}

/// Plan detail header dates from activity times. Null when there is no line to show.
/// Earliest start and latest end; an activity with no end uses its start.
/// Same calendar day in the plan zone is one date. No activities, or none with a
/// start, hides the line. Empty plan zone uses the device zone.
String? planHeaderDateLine(
  List<Activity> activities, {
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  if (activities.isEmpty) return null;
  DateTime? earliestStart;
  DateTime? latestEnd;
  for (final activity in activities) {
    final start = activity.startTime;
    final end = activity.endTime ?? start;
    if (start != null &&
        (earliestStart == null || start.isBefore(earliestStart))) {
      earliestStart = start;
    }
    if (end != null && (latestEnd == null || end.isAfter(latestEnd))) {
      latestEnd = end;
    }
  }
  return planSpanDateLine(
    earliestStart: earliestStart,
    latestEnd: latestEnd,
    planTimeZone: planTimeZone,
    deviceTimeZone: deviceTimeZone,
  );
}

DateTime _ymdDate(String value) {
  return DateTime.utc(
    int.parse(value.substring(0, 4)),
    int.parse(value.substring(5, 7)),
    int.parse(value.substring(8, 10)),
  );
}

const _weekdayAbbreviations = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const _monthAbbreviations = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

String _weekdayAbbreviation(String dayKey) {
  return _weekdayAbbreviations[_ymdDate(dayKey).weekday - 1];
}

String _dayMonthLabel(String dayKey) {
  final date = _ymdDate(dayKey);
  return '${date.day}-${_monthAbbreviations[date.month - 1]}';
}

/// Day headers for an itinerary and the PDF. The first activity that has a
/// start is Day 1. A later calendar day keeps the gap, so six days later is
/// Day 7. The same calendar day keeps that number and does not repeat the
/// header. A dated label is `Day 1 · Mon 20-Oct`: the English weekday and the
/// calendar date in [planTimeZone], with no leading zero and a three-letter
/// month. An activity with no start stays `Day 1` until a date exists. An
/// empty plan zone uses [deviceTimeZone], then the device zone.
List<String?> planItineraryDayHeaders(
  List<DateTime?> starts, {
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  final headers = List<String?>.filled(starts.length, null);
  final dayKeys = <String?>[
    for (final start in starts)
      start == null
          ? null
          : formatPlanHeaderDate(
              start,
              planTimeZone: planTimeZone,
              deviceTimeZone: deviceTimeZone,
            ),
  ];
  String? origin;
  for (final key in dayKeys) {
    if (key != null) {
      origin = key;
      break;
    }
  }
  String? previousDay;
  for (var index = 0; index < starts.length; index++) {
    final dayKey = dayKeys[index];
    if (index != 0 && dayKey == previousDay) continue;
    previousDay = dayKey;
    final number = origin == null || dayKey == null
        ? 1
        : _ymdDate(dayKey).difference(_ymdDate(origin)).inDays + 1;
    headers[index] = dayKey == null
        ? 'Day $number'
        : 'Day $number · ${_weekdayAbbreviation(dayKey)} ${_dayMonthLabel(dayKey)}';
  }
  return headers;
}

/// One calendar day in the itinerary span. [label] matches the day header,
/// such as `Day 2 · Fri 2-Oct`.
class PlanItineraryDay {
  final int number;
  final String dayKey;
  final String label;

  const PlanItineraryDay({
    required this.number,
    required this.dayKey,
    required this.label,
  });
}

/// Every calendar day from the earliest start through the latest end, in the
/// plan time zone. A day with no activity is included. Empty when nothing has
/// a start. An empty plan zone uses [deviceTimeZone], then the device zone.
List<PlanItineraryDay> planItinerarySpan({
  required List<DateTime?> starts,
  required List<DateTime?> ends,
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  String? keyOf(DateTime? instant) {
    if (instant == null) return null;
    return formatPlanHeaderDate(
      instant,
      planTimeZone: planTimeZone,
      deviceTimeZone: deviceTimeZone,
    );
  }

  String? origin;
  String? last;
  for (final start in starts) {
    final key = keyOf(start);
    if (key == null) continue;
    if (origin == null || key.compareTo(origin) < 0) origin = key;
    if (last == null || key.compareTo(last) > 0) last = key;
  }
  if (origin == null || last == null) return const [];
  var latest = last;
  final count = ends.length < starts.length ? ends.length : starts.length;
  for (var index = 0; index < count; index++) {
    final key = keyOf(ends[index]) ?? keyOf(starts[index]);
    if (key != null && key.compareTo(latest) > 0) latest = key;
  }

  final days = <PlanItineraryDay>[];
  var cursor = _ymdDate(origin);
  final endDate = _ymdDate(latest);
  var number = 1;
  while (!cursor.isAfter(endDate)) {
    final key = _ymd(cursor.year, cursor.month, cursor.day);
    days.add(
      PlanItineraryDay(
        number: number,
        dayKey: key,
        label:
            'Day $number · ${_weekdayAbbreviation(key)} ${_dayMonthLabel(key)}',
      ),
    );
    cursor = DateTime.utc(cursor.year, cursor.month, cursor.day + 1);
    number++;
  }
  return days;
}

/// Activity indexes for each day in [days], in [starts] order. A day with no
/// start is an empty list. A null start is not placed on a day.
List<List<int>> planItineraryDayIndexes({
  required List<DateTime?> starts,
  required List<PlanItineraryDay> days,
  String planTimeZone = '',
  String? deviceTimeZone,
}) {
  final buckets = <String, List<int>>{
    for (final day in days) day.dayKey: <int>[],
  };
  for (var index = 0; index < starts.length; index++) {
    final start = starts[index];
    if (start == null) continue;
    final key = formatPlanHeaderDate(
      start,
      planTimeZone: planTimeZone,
      deviceTimeZone: deviceTimeZone,
    );
    final bucket = buckets[key];
    if (bucket != null) bucket.add(index);
  }
  return [for (final day in days) buckets[day.dayKey] ?? <int>[]];
}

const String archivedPlanMessage = 'This plan is archived.';

const guestHiddenFieldNames = <String>[
  'destination',
  'budget',
  'cost',
  'bookingReference',
  'details',
];

const guestHiddenFieldLabels = <String, String>{
  'destination': 'Destination',
  'budget': 'Budget',
  'cost': 'Cost',
  'bookingReference': 'Booking reference',
  'details': 'Details',
};

/// True when a Guest should not see [field]. Owner and Collaborator still see it.
bool guestCannotSeeField(String? storedRole, List<String> hiddenFields, String field) {
  if (storedRole?.trim() != 'Guest') return false;
  return hiddenFields.contains(field);
}

String _stringValue(dynamic value, {String fallback = ''}) {
  if (value == null) return fallback;
  if (value is Map) {
    final id = value['_id'] ?? value['id'];
    if (id != null) return id.toString();
  }
  final text = value.toString();
  return text.isEmpty ? fallback : text;
}

DateTime? _dateValue(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}

List<String> _stringList(dynamic value) {
  if (value is! List) return [];
  return value.map((item) => item.toString()).toList();
}

List<PlanUser> _participants(dynamic value) {
  if (value is! List) return [];
  final people = <PlanUser>[];
  for (final item in value) {
    if (item is! Map) continue;
    final map = Map<String, dynamic>.from(item);
    final userId = map['userId'];
    if (userId is Map) {
      map['userId'] = _stringValue(userId);
    } else if (userId != null) {
      map['userId'] = userId.toString();
    }
    people.add(PlanUser.fromJson(map));
  }
  return people;
}

class Plan {
  final String id;
  final String type;
  final String name;
  final String destination;
  final DateTime? startDate;
  final DateTime? endDate;
  final bool autoCalculateStartDate;
  final bool autoCalculateEndDate;
  final String location;
  final double? budget;
  final String planningState; // "initial", "reviewing", "complete"
  final String timeZone;
  final List<PlanUser> participants;
  final String ownerId;
  final List<String> activityIds; // Links to activities
  final DateTime createdAt;
  final DateTime? earliestStart;
  final DateTime? latestEnd;
  final String sourcePlanId;
  final List<String> linkedActivityIds;
  final DateTime? linkStart;
  final DateTime? linkEnd;
  final List<String> hiddenFields;
  final String status;
  final String archiveDescription;
  final DateTime? archivedAt;
  final String archivedBy;

  bool get isArchived => status == 'archived';

  Plan({
    required this.id, // planID?
    required this.type,
    required this.name,
    required this.destination,
    required this.startDate,
    required this.endDate,
    required this.autoCalculateStartDate,
    required this.autoCalculateEndDate,
    required this.location,
    required this.budget,
    required this.planningState,
    required this.timeZone,
    this.participants = const [],
    required this.ownerId,
    this.activityIds = const [],
    required this.createdAt,
    this.earliestStart,
    this.latestEnd,
    this.sourcePlanId = '',
    this.linkedActivityIds = const [],
    this.linkStart,
    this.linkEnd,
    this.hiddenFields = const [],
    this.status = 'active',
    this.archiveDescription = '',
    this.archivedAt,
    this.archivedBy = '',
  });

  /// Same plan with the name and time zone from a saved itinerary snapshot.
  Plan withSavedHeader({required String name, required String timeZone}) {
    return Plan(
      id: id,
      type: type,
      name: name,
      destination: destination,
      startDate: startDate,
      endDate: endDate,
      autoCalculateStartDate: autoCalculateStartDate,
      autoCalculateEndDate: autoCalculateEndDate,
      location: location,
      budget: budget,
      planningState: planningState,
      timeZone: timeZone,
      participants: participants,
      ownerId: ownerId,
      activityIds: activityIds,
      createdAt: createdAt,
      earliestStart: earliestStart,
      latestEnd: latestEnd,
      sourcePlanId: sourcePlanId,
      linkedActivityIds: linkedActivityIds,
      linkStart: linkStart,
      linkEnd: linkEnd,
      hiddenFields: hiddenFields,
      status: status,
      archiveDescription: archiveDescription,
      archivedAt: archivedAt,
      archivedBy: archivedBy,
    );
  }

  factory Plan.fromJson(Map<String, dynamic> json) {
    /*
    logger.i(
      'Raw participants JSON: ${json['participants']} (type: ${json['participants'].runtimeType})',
    ); // Debug: See backend format
    final rawList = json['participants'] ?? [];
    logger.i('Raw list length: ${rawList.length}'); // Debug: Length before map
    final parsedList = (json['participants'] ?? [])
    .map<PlanUser>((p) => PlanUser.fromJson(p as Map<String, dynamic>))
    .toList(),
    logger.i(
      'Parsed participants length: ${parsedList.length} (type: ${parsedList.runtimeType})',
    ); // Debug: After map
    */

    return Plan(
      id: _stringValue(json['id'] ?? json['_id']),
      type: _stringValue(json['type']),
      name: _stringValue(json['name']),
      destination: _stringValue(json['destination']),
      startDate: _dateValue(json['startDate']),
      endDate: _dateValue(json['endDate']),
      autoCalculateStartDate: json['autoCalculateStartDate'] ?? false,
      autoCalculateEndDate: json['autoCalculateEndDate'] ?? false,
      location: _stringValue(json['location']),
      budget: json['budget'] is num ? (json['budget'] as num).toDouble() : null,
      planningState: _stringValue(json['planningState'], fallback: 'initial'),
      timeZone: _stringValue(json['timeZone']).trim(),
      participants: _participants(json['participants']),
      activityIds: _stringList(json['eventIds'] ?? json['activityIds']),
      ownerId: _stringValue(json['ownerId']),
      createdAt:
          _dateValue(json['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      earliestStart: _dateValue(json['earliestStart']),
      latestEnd: _dateValue(json['latestEnd']),
      sourcePlanId: _stringValue(json['sourcePlanId']),
      linkedActivityIds: _stringList(json['linkedActivityIds']),
      linkStart: _dateValue(json['linkStart']),
      linkEnd: _dateValue(json['linkEnd']),
      hiddenFields: _stringList(json['hiddenFields']),
      status: _stringValue(json['status'], fallback: 'active'),
      archiveDescription: _stringValue(json['archiveDescription']),
      archivedAt: _dateValue(json['archivedAt']),
      archivedBy: _stringValue(json['archivedBy']),
    );
  }
  /*
  // Factory to create from JSON (for API responses from backend)
  factory Plan.fromJson(Map<String, dynamic> json) {
    return Plan(
      id: json['_id'] ?? '',
      type: json['type'] ?? '',
      name: json['name'] ?? '',
      destination: json['destination'] ?? '',
      startDate: DateTime.parse(
        json['startDate'] ?? DateTime.now().toIso8601String(),
      ),
      endDate: DateTime.parse(
        json['endDate'] ?? DateTime.now().toIso8601String(),
      ),
      autoCalculateStartDate: json['autoCalculateStartDate'] ?? false,
      autoCalculateEndDate: json['autoCalculateEndDate'] ?? false,
      location: json['location'] ?? '',
      budget: (json['budget'] ?? 0.0).toDouble(),
      planningState: json['planningState'] ?? 'initial',
      timeZone: json['timeZone'] ?? 'UTC',
      participants: (json['participants'] ?? [])
          .map((p) => PlanUser.fromJson(p))
          .toList(),
      ownerId: json['ownerId'] ?? '',
      activityIds: List<String>.from(json['eventIds'] ?? []),
      createdAt: DateTime.parse(
        json['createdAt'] ?? DateTime.now().toIso8601String(),
      ),
    );
  }
  */

  // To JSON for API sends
  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'name': name,
      'destination': destination,
      'startDate': startDate?.toIso8601String(),
      'endDate': endDate?.toIso8601String(),
      'autoCalculateStartDate': autoCalculateStartDate,
      'autoCalculateEndDate': autoCalculateEndDate,
      'location': location,
      'budget': budget,
      'planningState': planningState,
      'participants': participants
          .map((p) => p.toJson())
          .toList(), // Serialize list
      'timeZone': timeZone,
      'ownerId': ownerId,
    };
  }
}
