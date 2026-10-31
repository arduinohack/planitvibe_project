import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config/constants.dart';
import '../models/activity.dart';
import '../models/activity_reaction.dart';
import '../models/plan.dart';
import '../models/plan_member.dart';
import '../models/plan_role_label.dart';
import '../presence/plan_presence.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import '../utils/ai_command_history.dart';
import '../utils/activity_chain.dart';
import '../utils/activity_time.dart';
import '../utils/logger.dart';
import '../utils/place_suggestion_fill.dart';
import '../utils/plus_upgrade.dart';
import '../utils/place_suggestion_lines.dart';
import '../utils/plan_pdf.dart';
import '../widgets/activity_attachments.dart';
import 'activity_history_screen.dart';
import 'login_screen.dart';
import 'plan_people_screen.dart';

const activityTypes = [
  'flight',
  'train',
  'car',
  'car_service',
  'dining',
  'hotel',
  'tour',
  'attraction',
  'cruise',
  'ceremony',
  'reception',
  'shuttle',
  'custom',
  'activity',
];

const _activityTypeLabels = {
  'flight': 'Flight',
  'train': 'Train',
  'car': 'Drive',
  'car_service': 'Car Service',
  'dining': 'Dining',
  'hotel': 'Hotel',
  'tour': 'Tour',
  'attraction': 'Attraction',
  'cruise': 'Cruise',
  'ceremony': 'Ceremony',
  'reception': 'Reception',
  'shuttle': 'Shuttle',
  'custom': 'Custom',
  'activity': 'Activity',
};

String activityTypeLabel(String type) {
  final known = _activityTypeLabels[type.trim().toLowerCase()];
  if (known != null) return known;
  return type;
}

enum _ActivityInput {
  type,
  name,
  paste,
  shuttleOrigin,
  shuttleOriginCountry,
  shuttleDestination,
  start,
  end,
  duration,
  legs,
  location,
  placeId,
  details,
  bookingReference,
  cost,
  gate,
  baggage,
  room,
  shuttleConfirmation,
}

/// Name, start, end, duration, details, and cost stay above the separator
/// for every type. These sets are the fields that sit below it.
const _locationTypes = {
  'car',
  'drive',
  'car_service',
  'carservice',
  'dining',
  'hotel',
  'tour',
  'attraction',
  'cruise',
  'ceremony',
  'reception',
  'custom',
  'ferry',
  'bus',
  'walk',
};

const _placeIdTypes = {
  'car',
  'drive',
  'car_service',
  'carservice',
  'shuttle',
  'dining',
  'hotel',
  'tour',
  'attraction',
  'ceremony',
  'reception',
  'cruise',
  'custom',
  'flight',
  'train',
  'ferry',
  'bus',
  'transport',
  'taxi',
  'walk',
};

const _bookingReferenceTypes = {
  'flight',
  'hotel',
  'cruise',
  'ferry',
  'shuttle',
  'train',
  'car_service',
  'carservice',
  'tour',
  'bus',
  'transport',
  'carrental',
  'car_rental',
};

const _routePlaceTypes = {'shuttle', 'train', 'cruise'};

const _confirmationTypes = {'flight', 'shuttle', 'train', 'cruise', 'hotel'};

const _roomTypes = {'hotel', 'ceremony', 'reception'};

const _serviceProviderTypes = {
  'flight',
  'train',
  'carrental',
  'car_rental',
  'car_service',
  'carservice',
  'bus',
  'ferry',
  'hotel',
  'tour',
  'transport',
  'cruise',
};

String _storedTypeKey(String type) => type.trim().toLowerCase();

bool _typeUsesLocation(String type) =>
    _locationTypes.contains(_storedTypeKey(type));

bool _typeUsesPlaceId(String type) =>
    _placeIdTypes.contains(_storedTypeKey(type));

bool _typeUsesBookingReference(String type) =>
    _bookingReferenceTypes.contains(_storedTypeKey(type));

bool _typeUsesRoutePlaces(String type) =>
    _routePlaceTypes.contains(_storedTypeKey(type));

bool _typeUsesConfirmation(String type) =>
    _confirmationTypes.contains(_storedTypeKey(type));

bool _typeUsesRoom(String type) => _roomTypes.contains(_storedTypeKey(type));

bool _typeUsesFlightFields(String type) => _storedTypeKey(type) == 'flight';

bool _typeUsesShuttleFields(String type) => _storedTypeKey(type) == 'shuttle';

bool _typeUsesServiceProvider(String type) =>
    _serviceProviderTypes.contains(_storedTypeKey(type));

bool _typeUsesCustomType(String type) => _storedTypeKey(type) == 'custom';

/// Status and links are shared storage. A plain Activity does not show them.
bool _typeUsesStatusOrLinks(String type) {
  final key = _storedTypeKey(type);
  return key.isNotEmpty && key != 'activity';
}

class _FieldHint extends StatelessWidget {
  final String message;

  const _FieldHint(this.message);

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: message,
      triggerMode: TooltipTriggerMode.tap,
      showDuration: const Duration(seconds: 6),
      child: const Icon(Icons.help_outline, size: 20),
    );
  }
}

/// Hover on web and desktop. Long-press on touch.
Widget _fieldTooltip(String message, Widget child) {
  if (message.isEmpty) return child;
  return Tooltip(message: message, child: child);
}

/// A text field wins the long-press gesture for selection, so touch uses a timer.
class _TextInputTooltip extends StatefulWidget {
  final String message;
  final Widget child;

  const _TextInputTooltip({required this.message, required this.child});

  @override
  State<_TextInputTooltip> createState() => _TextInputTooltipState();
}

class _TextInputTooltipState extends State<_TextInputTooltip> {
  static const _touchKinds = <PointerDeviceKind>{
    PointerDeviceKind.touch,
    PointerDeviceKind.stylus,
    PointerDeviceKind.invertedStylus,
    PointerDeviceKind.unknown,
    PointerDeviceKind.trackpad,
  };

  final GlobalKey<TooltipState> _tooltipKey = GlobalKey<TooltipState>();
  int _pressGeneration = 0;
  Offset? _downPosition;

  void _cancelPress() {
    _pressGeneration++;
    _downPosition = null;
  }

  void _onPointerDown(PointerDownEvent event) {
    if (!_touchKinds.contains(event.kind)) return;
    _pressGeneration++;
    final generation = _pressGeneration;
    _downPosition = event.position;
    Future<void>.delayed(kLongPressTimeout, () {
      if (!mounted || generation != _pressGeneration) return;
      _tooltipKey.currentState?.ensureTooltipVisible();
    });
  }

  void _onPointerMove(PointerMoveEvent event) {
    final origin = _downPosition;
    if (origin == null) return;
    if ((event.position - origin).distance > kTouchSlop) _cancelPress();
  }

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      key: _tooltipKey,
      message: widget.message,
      triggerMode: TooltipTriggerMode.manual,
      child: Listener(
        onPointerDown: _onPointerDown,
        onPointerMove: _onPointerMove,
        onPointerUp: (_) => _cancelPress(),
        onPointerCancel: (_) => _cancelPress(),
        child: widget.child,
      ),
    );
  }
}

Widget _textTooltip(String message, Widget child) {
  if (message.isEmpty) return child;
  return _TextInputTooltip(message: message, child: child);
}

bool canAddActivity(String? storedRole) {
  final role = storedRole?.trim();
  return role == 'Owner' || role == 'Collaborator';
}

bool canEditPlan(String? storedRole) {
  final role = storedRole?.trim();
  return role == 'Owner' || role == 'Collaborator';
}

DateTime _clampCalendarDate(int year, int month, int day) {
  final date = DateTime(year, month, day);
  final first = DateTime(2000);
  final last = DateTime(2100);
  if (date.isBefore(first)) return first;
  if (date.isAfter(last)) return last;
  return date;
}

String _dateTimeButtonLabel(
  DateTime? instant,
  String? zone, {
  bool showDaylightLabel = false,
}) {
  if (instant == null) return 'Choose date and time';
  final named = zone?.trim() ?? '';
  if (showDaylightLabel) return planClockButtonLabel(instant, named);
  if (named.isEmpty) return '${itineraryClockLabel(instant, 'UTC')} UTC';
  return itineraryClockLabel(instant, named);
}

Future<DateTime?> _pickDateAndTime(
  BuildContext context, {
  required String label,
  required DateTime? instant,
  required String? zone,
}) {
  final named = zone?.trim() ?? '';
  final clockZone = named.isEmpty ? 'UTC' : named;
  final seeded = instant ?? DateTime.now().toUtc();
  final wall = wallValue(seeded, clockZone);
  final clock = wall ?? seeded.toUtc();
  return showDialog<DateTime>(
    context: context,
    builder: (context) => _ZoneDateTimeDialog(
      title: label,
      zone: clockZone,
      date: _clampCalendarDate(clock.year, clock.month, clock.day),
      hour: clock.hour,
      minute: clock.minute,
    ),
  );
}

/// Activity start and flight departure. An empty instant uses the activity
/// above, then 8:30 in the plan zone.
Future<DateTime?> _pickStartTime(
  BuildContext context, {
  required String label,
  required DateTime? instant,
  required String? zone,
  required String planTimeZone,
  DateTime? aboveInstant,
  DateTime? fallbackStart,
}) {
  final named = zone?.trim() ?? '';
  final clockZone = named.isEmpty ? 'UTC' : named;
  final planZone = planTimeZone.trim().isEmpty ? 'UTC' : planTimeZone.trim();
  final seeded = instant ??
      aboveInstant ??
      fallbackStart ??
      defaultChainStart(existingStarts: const [], planTimeZone: planZone);
  final wall = wallValue(seeded, clockZone);
  final clock = wall ?? seeded.toUtc();
  return showDialog<DateTime>(
    context: context,
    builder: (context) => _StartTimePanel(
      title: label,
      zone: clockZone,
      planTimeZone: planZone,
      date: _clampCalendarDate(clock.year, clock.month, clock.day),
      hour: clock.hour,
      minute: clock.minute,
      aboveInstant: aboveInstant,
    ),
  );
}

/// Last itinerary row that has a time. Its end, or its start when the end is empty.
DateTime? _defaultActivityStart(List<Activity> activities) {
  for (var index = activities.length - 1; index >= 0; index--) {
    final activity = activities[index];
    if (activity.endTime != null) return activity.endTime;
    if (activity.startTime != null) return activity.startTime;
  }
  return null;
}

class _ShownActivityTimes {
  final DateTime? start;
  final DateTime? end;

  const _ShownActivityTimes({this.start, this.end});
}

String _activityStartZone(Activity activity, String planZone) {
  final start = activity.startTimeZone.trim();
  if (start.isNotEmpty) return start;
  final origin = activity.originTimeZone?.trim() ?? '';
  if (origin.isNotEmpty) return origin;
  final zone = activity.timeZone.trim();
  if (zone.isNotEmpty) return zone;
  final plan = planZone.trim();
  if (plan.isNotEmpty) return plan;
  return 'UTC';
}

String _activityEndZone(Activity activity, String planZone) {
  final end = activity.endTimeZone.trim();
  if (end.isNotEmpty) return end;
  final destination = activity.destinationTimeZone?.trim() ?? '';
  if (destination.isNotEmpty) return destination;
  return _activityStartZone(activity, planZone);
}

/// Display times for the itinerary chain. Stored times are not rewritten.
List<_ShownActivityTimes> _shownActivityTimes(List<Activity> activities) {
  final shown = <_ShownActivityTimes>[];
  DateTime? anchor;
  for (final activity in activities) {
    final storedStart = activity.startTime;
    final storedEnd = activity.endTime;
    final minutes = activity.duration?.inMinutes;
    final DateTime? start;
    final DateTime? end;
    if (storedStart == null && minutes == null) {
      start = anchor;
      end = storedEnd ?? start;
    } else {
      start = storedStart ?? anchor;
      if (storedEnd != null) {
        end = storedEnd;
      } else if (minutes != null && start != null) {
        end = start.add(Duration(minutes: minutes));
      } else {
        end = null;
      }
    }
    shown.add(_ShownActivityTimes(start: start, end: end));
    anchor = end ?? start;
  }
  return shown;
}

String _pdfClock(DateTime? instant, String zone) {
  if (instant == null) return 'not set';
  final label = zoneDaylightLabel(instant, zone).trim();
  final clock = itineraryClockLabel(instant, zone);
  if (label.isEmpty) return clock;
  return '$clock $label';
}

String _durationLabel(Activity activity) {
  final minutes = activity.duration?.inMinutes;
  if (minutes != null) return '$minutes min';
  final start = activity.startTime;
  final end = activity.endTime;
  if (start != null && end != null) {
    return '${end.difference(start).inMinutes} min';
  }
  return 'not set';
}

String _detailsLabel(Activity activity) {
  final details = activity.details?.trim() ?? '';
  if (details.isEmpty) return 'not set';
  return details;
}

String? _cardStatusLabel(String? status) {
  final text = status?.trim() ?? '';
  if (text.isEmpty) return null;
  switch (text.toLowerCase()) {
    case 'draft':
      return 'Draft';
    case 'complete':
      return 'Complete';
    default:
      return text;
  }
}

String? _cardDurationLabel(Activity activity) {
  final minutes = activity.duration?.inMinutes;
  if (minutes != null) return '$minutes min';
  final start = activity.startTime;
  final end = activity.endTime;
  if (start != null && end != null) {
    return '${end.difference(start).inMinutes} min';
  }
  return null;
}

Widget _cardLine(String label, String value) {
  return Text.rich(
    TextSpan(
      children: [
        TextSpan(
          text: '$label: ',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        TextSpan(text: value),
      ],
    ),
  );
}

void _addCardLine(List<Widget> lines, String label, String? value) {
  final text = value?.trim() ?? '';
  if (text.isEmpty || text == 'not set') return;
  lines.add(_cardLine(label, text));
}

String _flightLegCardText(FlightLeg leg, String startZone, String endZone) {
  final parts = <String>[];
  final origin = leg.origin.trim();
  final departureZone = leg.originTimeZone.trim().isNotEmpty
      ? leg.originTimeZone.trim()
      : startZone;
  final arrivalZone = leg.destinationTimeZone.trim().isNotEmpty
      ? leg.destinationTimeZone.trim()
      : endZone;
  if (origin.isNotEmpty) parts.add(origin);
  if (leg.departure != null) {
    parts.add(_pdfClock(leg.departure, departureZone));
  }
  final minutes = _shownLegMinutes(leg);
  if (minutes != null) parts.add('$minutes min');
  final destination = leg.destination.trim();
  if (destination.isNotEmpty) parts.add(destination);
  if (leg.arrival != null) {
    parts.add(_pdfClock(leg.arrival, arrivalZone));
  }
  return parts.where((part) => part.trim().isNotEmpty && part.trim() != 'not set').join(', ');
}

int? _shownLegMinutes(FlightLeg leg) {
  final stored = leg.durationMinutes;
  if (stored != null) return stored;
  final departure = leg.departure;
  final arrival = leg.arrival;
  if (departure == null || arrival == null || arrival.isBefore(departure)) {
    return null;
  }
  return arrival.difference(departure).inMinutes;
}

class _ActivityCardContent {
  final List<Widget> above;
  final List<Widget> below;

  const _ActivityCardContent({required this.above, required this.below});
}

String _activityStoredType(Activity activity) {
  final label = activity.typeLabel.trim();
  if (label.isNotEmpty) return label;
  return activity.type.name;
}

_ActivityCardContent _activityCardContent(
  Activity activity,
  _ShownActivityTimes times,
  String planZone, {
  Set<String> hiddenFields = const {},
}) {
  final above = <Widget>[];
  final below = <Widget>[];
  final storedType = _activityStoredType(activity);
  final startZone = _activityStartZone(activity, planZone);
  final endZone = _activityEndZone(activity, planZone);
  if (times.start != null) {
    _addCardLine(above, 'Start', _pdfClock(times.start, startZone));
  }
  if (times.end != null) {
    _addCardLine(above, 'End', _pdfClock(times.end, endZone));
  }
  _addCardLine(above, 'Duration', _cardDurationLabel(activity));
  if (!hiddenFields.contains('details')) {
    _addCardLine(above, 'Details', activity.details);
  }
  final cost = activity.cost;
  if (cost != null && !hiddenFields.contains('cost')) {
    final mark = activity.costType == CostType.actual ? 'act' : 'est';
    _addCardLine(above, 'Cost($mark)', formatPlanMoney(cost));
  }
  if (_typeUsesFlightFields(storedType)) {
    for (var index = 0; index < activity.legs.length; index++) {
      _addCardLine(
        below,
        'Leg ${index + 1}',
        _flightLegCardText(activity.legs[index], startZone, endZone),
      );
    }
    _addCardLine(below, 'Gate', activity.gate);
    _addCardLine(below, 'Baggage claim', activity.baggageClaim);
  }
  if (_typeUsesRoutePlaces(storedType)) {
    _addCardLine(below, 'Origin', activity.origin);
    if (_typeUsesShuttleFields(storedType)) {
      _addCardLine(below, 'Origin country', activity.originCountry);
    }
    _addCardLine(below, 'Destination', activity.destination);
  }
  final placeId = activity.googlePlaceId.trim();
  final placeReplacesLocation =
      _typeUsesPlaceId(storedType) && placeId.isNotEmpty;
  if (_typeUsesLocation(storedType) && !placeReplacesLocation) {
    _addCardLine(below, 'Location', activity.location);
  }
  if (!hiddenFields.contains('bookingReference') &&
      _typeUsesBookingReference(storedType)) {
    _addCardLine(below, 'Booking reference', activity.bookingReference);
  }
  if (_typeUsesConfirmation(storedType)) {
    _addCardLine(below, 'Confirmation', activity.confirmation);
  }
  if (_typeUsesRoom(storedType)) {
    _addCardLine(below, 'Room number', activity.roomNumber);
  }
  if (_typeUsesServiceProvider(storedType)) {
    _addCardLine(below, 'Service provider', activity.serviceProvider);
  }
  if (_typeUsesStatusOrLinks(storedType)) {
    final status = activity.status?.trim().toLowerCase() ?? '';
    if (status.isNotEmpty && status != 'draft') {
      _addCardLine(below, 'Status', _cardStatusLabel(activity.status));
    }
    for (final link in activity.urlLinks) {
      final url = link.linkUrl.trim();
      if (url.isEmpty) continue;
      final name = link.linkName.trim();
      _addCardLine(below, 'Link', name.isEmpty ? url : '$name ($url)');
    }
  }
  if (_typeUsesCustomType(storedType)) {
    _addCardLine(below, 'Custom type', activity.customType);
  }
  return _ActivityCardContent(above: above, below: below);
}

/// Driving directions when the activity has a stored Google Place ID.
Uri? _activityDirectionsUri(Activity activity) {
  final placeId = activity.googlePlaceId.trim();
  if (placeId.isEmpty) return null;
  final location = activity.location?.trim() ?? '';
  final name = activity.name.trim();
  final destination = location.isNotEmpty
      ? location
      : name.isNotEmpty
          ? name
          : placeId;
  return Uri.https('www.google.com', '/maps/dir/', {
    'api': '1',
    'destination': destination,
    'destination_place_id': placeId,
    'travelmode': 'driving',
  });
}

class _PlusArrowIcon extends StatelessWidget {
  final bool up;

  const _PlusArrowIcon({required this.up});

  @override
  Widget build(BuildContext context) {
    final color = IconTheme.of(context).color;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.add, size: 18, color: color),
        Icon(
          up ? Icons.arrow_upward : Icons.arrow_downward,
          size: 18,
          color: color,
        ),
      ],
    );
  }
}

List<String?> _dayHeaders(
  List<_ShownActivityTimes> times,
  String planZone,
) {
  return planItineraryDayHeaders(
    [for (final time in times) time.start],
    planTimeZone: planZone,
  );
}

/// Itinerary order for the plan detail list. Compares the stored UTC start
/// instant, so the order does not depend on the device time zone. An activity
/// with no start sorts after one that has a start. Equal starts keep their
/// current order. Own rows and linked rows share this list.
List<Activity> activitiesByUtcStart(List<Activity> activities) {
  final indexed = <({Activity activity, int index})>[
    for (var index = 0; index < activities.length; index++)
      (activity: activities[index], index: index),
  ];
  indexed.sort((a, b) {
    final byStart = _compareUtcStart(a.activity.startTime, b.activity.startTime);
    if (byStart != 0) return byStart;
    return a.index.compareTo(b.index);
  });
  return [for (final item in indexed) item.activity];
}

int _compareUtcStart(DateTime? left, DateTime? right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left.toUtc().compareTo(right.toUtc());
}

const placeSearchDebounce = Duration(milliseconds: 300);

/// What a chosen place writes on the activity form.
/// [location] is the place name, or null when that name is blank.
class PlaceSelection {
  final String googlePlaceId;
  final String? location;

  const PlaceSelection({required this.googlePlaceId, this.location});
}

/// Search text that should replace the box when Location changes.
/// Null means leave the box alone. An empty string clears it.
/// A search the user has changed does not follow Location.
String? placeSearchTextFromLocation({
  required String location,
  required String search,
  required String seed,
}) {
  final next = location.trim();
  final current = search.trim();
  if (current.isNotEmpty && current != seed.trim()) return null;
  if (current == next) return null;
  return next;
}

/// Sets the Place ID and copies the place name into the location field.
/// A blank name leaves the current location alone.
PlaceSelection applyPlaceSelection({
  required String location,
  required String placeId,
  required String name,
}) {
  final displayName = name.trim();
  return PlaceSelection(
    googlePlaceId: placeId.trim(),
    location: displayName.isEmpty ? null : displayName,
  );
}

int? _wholeMinutes(String text) {
  final trimmed = text.trim();
  if (!RegExp(r'^\d+$').hasMatch(trimmed)) return null;
  return int.tryParse(trimmed);
}

class _ZoneDateTimeDialog extends StatefulWidget {
  final String title;
  final String zone;
  final DateTime date;
  final int hour;
  final int minute;

  const _ZoneDateTimeDialog({
    required this.title,
    required this.zone,
    required this.date,
    required this.hour,
    required this.minute,
  });

  @override
  State<_ZoneDateTimeDialog> createState() => _ZoneDateTimeDialogState();
}

class _ZoneDateTimeDialogState extends State<_ZoneDateTimeDialog> {
  late DateTime _date;
  late int _hour;
  late int _minute;

  @override
  void initState() {
    super.initState();
    _date = widget.date;
    _hour = widget.hour;
    _minute = widget.minute;
  }

  String get _zoneLabel {
    final instant = instantFromWall(
      year: _date.year,
      month: _date.month,
      day: _date.day,
      hour: _hour,
      minute: _minute,
      zone: widget.zone,
    );
    return zoneDaylightLabel(instant, widget.zone);
  }

  void _confirm() {
    final instant = instantFromWall(
      year: _date.year,
      month: _date.month,
      day: _date.day,
      hour: _hour,
      minute: _minute,
      zone: widget.zone,
    );
    Navigator.pop(context, instant);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 360,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(_zoneLabel, style: const TextStyle(fontWeight: FontWeight.w600)),
              SizedBox(
                height: 340,
                child: CalendarDatePicker(
                  initialDate: _date,
                  firstDate: DateTime(2000),
                  lastDate: DateTime(2100),
                  onDateChanged: (picked) {
                    setState(() {
                      _date = _clampCalendarDate(picked.year, picked.month, picked.day);
                    });
                  },
                ),
              ),
              const Text('Time', style: TextStyle(fontWeight: FontWeight.w600)),
              SizedBox(
                height: 160,
                child: CupertinoTheme(
                  data: CupertinoThemeData(
                    brightness: Theme.of(context).brightness,
                    textTheme: CupertinoTextThemeData(
                      dateTimePickerTextStyle: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  child: CupertinoDatePicker(
                    mode: CupertinoDatePickerMode.time,
                    use24hFormat: true,
                    initialDateTime: DateTime(
                      widget.date.year,
                      widget.date.month,
                      widget.date.day,
                      widget.hour,
                      widget.minute,
                    ),
                    onDateTimeChanged: (picked) {
                      if (picked.hour == _hour && picked.minute == _minute) {
                        return;
                      }
                      setState(() {
                        _hour = picked.hour;
                        _minute = picked.minute;
                      });
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(onPressed: _confirm, child: const Text('Confirm')),
      ],
    );
  }
}

class _StartTimePanel extends StatefulWidget {
  final String title;
  final String zone;
  final String planTimeZone;
  final DateTime date;
  final int hour;
  final int minute;
  final DateTime? aboveInstant;

  const _StartTimePanel({
    required this.title,
    required this.zone,
    required this.planTimeZone,
    required this.date,
    required this.hour,
    required this.minute,
    required this.aboveInstant,
  });

  @override
  State<_StartTimePanel> createState() => _StartTimePanelState();
}

class _StartTimePanelState extends State<_StartTimePanel> {
  late DateTime _date;
  late int _hour;
  late int _minute;
  int _wheelEpoch = 0;

  @override
  void initState() {
    super.initState();
    _date = widget.date;
    _hour = widget.hour;
    _minute = widget.minute;
  }

  DateTime get _instant => instantFromWall(
    year: _date.year,
    month: _date.month,
    day: _date.day,
    hour: _hour,
    minute: _minute,
    zone: widget.zone,
  );

  String get _zoneLabel => zoneDaylightLabel(_instant, widget.zone);

  void _showInstant(DateTime instant) {
    final clock = clockInZone(instant.toUtc(), widget.zone);
    setState(() {
      _date = _clampCalendarDate(clock.year, clock.month, clock.day);
      _hour = clock.hour;
      _minute = clock.minute;
      _wheelEpoch++;
    });
  }

  void _sameDay() {
    final next = sameDayKeepingTime(
      above: widget.aboveInstant,
      current: _instant,
      zone: widget.zone,
    );
    if (next == null) return;
    _showInstant(next);
  }

  void _shift(int minutes) => _showInstant(shiftByMinutes(_instant, minutes));

  void _nextMorning() =>
      _showInstant(nextPlanMorning(_instant, widget.planTimeZone));

  void _confirm() => Navigator.pop(context, _instant);

  @override
  Widget build(BuildContext context) {
    final sameDayEnabled = widget.aboveInstant != null;
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 400,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ActionChip(
                    label: const Text('Same day'),
                    tooltip: sameDayEnabled
                        ? 'Use the day of the activity above. Keeps this time, or that activity’s end time.'
                        : 'No activity is above this one.',
                    onPressed: sameDayEnabled ? _sameDay : null,
                  ),
                  ActionChip(
                    label: const Text('+30 min'),
                    tooltip: '30 minutes later',
                    onPressed: () => _shift(30),
                  ),
                  ActionChip(
                    label: const Text('+1 hour'),
                    tooltip: 'One hour later',
                    onPressed: () => _shift(60),
                  ),
                  ActionChip(
                    label: const Text('Next morning 8:30'),
                    tooltip: '8:30 AM the next day in the plan time zone.',
                    onPressed: _nextMorning,
                  ),
                ],
              ),
              SizedBox(
                height: 300,
                child: CalendarDatePicker(
                  key: ValueKey('day-$_wheelEpoch'),
                  initialDate: _date,
                  firstDate: DateTime(2000),
                  lastDate: DateTime(2100),
                  onDateChanged: (picked) {
                    setState(() {
                      _date = _clampCalendarDate(
                        picked.year,
                        picked.month,
                        picked.day,
                      );
                    });
                  },
                ),
              ),
              Row(
                children: [
                  const Text(
                    'Time',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const Spacer(),
                  Text(
                    _zoneLabel,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
              SizedBox(
                height: 160,
                child: CupertinoTheme(
                  data: CupertinoThemeData(
                    brightness: Theme.of(context).brightness,
                    textTheme: CupertinoTextThemeData(
                      dateTimePickerTextStyle: Theme.of(
                        context,
                      ).textTheme.titleLarge,
                    ),
                  ),
                  child: CupertinoDatePicker(
                    key: ValueKey('time-$_wheelEpoch'),
                    mode: CupertinoDatePickerMode.time,
                    use24hFormat: true,
                    initialDateTime: DateTime(
                      _date.year,
                      _date.month,
                      _date.day,
                      _hour,
                      _minute,
                    ),
                    onDateTimeChanged: (picked) {
                      if (picked.hour == _hour && picked.minute == _minute) {
                        return;
                      }
                      setState(() {
                        _hour = picked.hour;
                        _minute = picked.minute;
                      });
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(onPressed: _confirm, child: const Text('Confirm')),
      ],
    );
  }
}

class _UtcDateTimePicker extends StatelessWidget {
  final String id;
  final String label;
  final DateTime? value;
  final ValueChanged<DateTime> onChanged;
  final VoidCallback? onClear;
  final String? zone;
  final ValueChanged<String>? onZoneChanged;
  final bool enableClock;
  final bool showDaylightLabel;
  final bool useStartPanel;
  final String planTimeZone;
  final DateTime? aboveInstant;
  final DateTime? fallbackStart;
  final String hint;
  final String tooltip;
  final String zoneTooltip;

  const _UtcDateTimePicker({
    required this.id,
    required this.label,
    required this.value,
    required this.onChanged,
    this.hint = '',
    this.tooltip = '',
    this.zoneTooltip = '',
    this.onClear,
    this.zone,
    this.onZoneChanged,
    this.enableClock = true,
    this.showDaylightLabel = false,
    this.useStartPanel = false,
    this.planTimeZone = '',
    this.aboveInstant,
    this.fallbackStart,
  });

  @override
  Widget build(BuildContext context) {
    final instant = value;
    final selectedZone = zone;
    final changeZone = onZoneChanged;
    final zoneAnchor = instant ?? DateTime.now().toUtc();
    final zoneChoices = selectedZone == null
        ? const <String>[]
        : activityZoneOptions(selectedZone);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: _fieldTooltip(tooltip, Text(label))),
              if (hint.isNotEmpty) _FieldHint(hint),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _fieldTooltip(
                tooltip,
                OutlinedButton(
                  onPressed: enableClock
                      ? () async {
                          final next = useStartPanel
                              ? await _pickStartTime(
                                  context,
                                  label: label,
                                  instant: instant,
                                  zone: selectedZone,
                                  planTimeZone: planTimeZone,
                                  aboveInstant: aboveInstant,
                                  fallbackStart: fallbackStart,
                                )
                              : await _pickDateAndTime(
                                  context,
                                  label: label,
                                  instant: instant,
                                  zone: selectedZone,
                                );
                          if (next == null || !context.mounted) return;
                          onChanged(next);
                        }
                      : null,
                  child: Text(
                    _dateTimeButtonLabel(
                      instant,
                      selectedZone,
                      showDaylightLabel: showDaylightLabel,
                    ),
                  ),
                ),
              ),
              if (enableClock && onClear != null && instant != null)
                TextButton(onPressed: onClear, child: const Text('Clear')),
            ],
          ),
          if (selectedZone != null && changeZone != null) ...[
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _fieldTooltip(
                    zoneTooltip,
                    DropdownButtonFormField<String>(
                      key: ValueKey('$id|$selectedZone'),
                      initialValue: selectedZone,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Time zone'),
                      selectedItemBuilder: (context) => [
                        for (final choice in zoneChoices)
                          Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: Text(
                              zoneDaylightLabel(zoneAnchor, choice),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      items: [
                        for (final choice in zoneChoices)
                          DropdownMenuItem(value: choice, child: Text(choice)),
                      ],
                      onChanged: (next) {
                        if (next == null) return;
                        changeZone(next);
                      },
                    ),
                  ),
                ),
                if (hint.isNotEmpty)
                  const Padding(
                    padding: EdgeInsets.only(left: 4, top: 8),
                    child: _FieldHint(
                      'The time zone for this clock. The saved time stays in UTC.',
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class PlanDetailScreen extends StatefulWidget {
  final Plan plan;

  const PlanDetailScreen({super.key, required this.plan});

  @override
  State<PlanDetailScreen> createState() => _PlanDetailScreenState();
}

class _PlanDetailScreenState extends State<PlanDetailScreen> {
  bool _loaded = false;
  int? _status;
  final Set<String> _reactionBusy = <String>{};
  late Plan _plan;
  Plan? _linkedSource;
  List<PlanMember> _linkedPlanners = const [];
  int? _itineraryDay;
  bool _presenceStarted = false;
  PlanPresenceConnection? _presence;
  List<PlanViewer> _viewers = const [];
  String? _selfId;

  @override
  void initState() {
    super.initState();
    _plan = widget.plan;
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _presence?.close();
    _presence = null;
    super.dispose();
  }

  void _startPresence(String? token) {
    if (_presenceStarted) return;
    if (token == null || token.isEmpty) return;
    _presenceStarted = true;
    _selfId = userIdFromToken(token);
    final connection = PlanPresenceConnection(
      onUsers: (users) {
        if (!mounted) return;
        setState(() => _viewers = users);
      },
      onReaction: (event) {
        if (!mounted) return;
        Provider.of<PlanProvider>(context, listen: false).applyRemoteReaction(
          activityId: event.activityId,
          counts: event.counts,
          type: event.type,
          userId: event.userId,
          voted: event.voted,
          currentUserId: _selfId,
        );
      },
    );
    _presence = connection;
    connection.connect(
      baseUrl: backendBaseUrl,
      token: token,
      planId: widget.plan.id,
    );
  }

  Future<void> _load() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    _startPresence(userProvider.token);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    await userProvider.loadPlanAccess();
    if (!mounted) return;
    final status = await planProvider.fetchPlan(
      widget.plan.id,
      userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      setState(() {
        _loaded = true;
        _status = status;
      });
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status != 200) {
      setState(() {
        _loaded = true;
        _status = status;
      });
      return;
    }
    final saved = await _storeOpenPlan(planProvider, userProvider.token);
    if (!mounted) return;
    if (saved == 401) {
      setState(() {
        _loaded = true;
        _status = status;
      });
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    final linked = await _readLinkedPlan(planProvider, userProvider.token);
    if (!mounted) return;
    if (linked == 401) {
      setState(() {
        _loaded = true;
        _status = status;
      });
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    setState(() {
      _loaded = true;
      _status = status;
    });
  }

  /// GET /api/plans/:planId stores sourcePlanId from the saved plan.
  /// Returns 401 when the session ends. A missing plan leaves the saved id.
  Future<int?> _storeOpenPlan(PlanProvider planProvider, String? token) async {
    final read = await planProvider.readPlan(
      planId: widget.plan.id,
      token: token,
    );
    if (read.status == 401) return 401;
    final fresh = read.plan;
    if (fresh == null) return read.status;
    _plan = planProvider.storeReturnedPlan(fresh);
    return 200;
  }

  /// Source id from the open plan. The plan passed in at creation wins when the
  /// list copy has not kept the id from the 201 body.
  String _linkedSourceId(PlanProvider planProvider) {
    final shown = _shownPlan(planProvider).sourcePlanId.trim();
    if (shown.isNotEmpty) return shown;
    final opened = widget.plan.sourcePlanId.trim();
    if (opened.isNotEmpty) return opened;
    return _plan.sourcePlanId.trim();
  }

  /// Loads the source plan and its members. Returns 401 when the session ends.
  /// People come from the source plan, not this plan.
  Future<int?> _readLinkedPlan(PlanProvider planProvider, String? token) async {
    final sourceId = _linkedSourceId(planProvider);
    if (sourceId.isEmpty) {
      _linkedSource = null;
      _linkedPlanners = const [];
      return 200;
    }
    final listed = await planProvider.readPlan(
      planId: sourceId,
      token: token,
    );
    if (listed.status == 401) return 401;
    final source = listed.plan;
    if (source == null) {
      _linkedSource = null;
      _linkedPlanners = const [];
      return listed.status;
    }
    final members = await planProvider.readPlanMembers(
      planId: sourceId,
      token: token,
    );
    if (members.status == 401) return 401;
    _linkedSource = source;
    _linkedPlanners = members.status == 200
        ? linkedPlanPlanners(members.members)
        : const [];
    return members.status;
  }

  Future<void> _endSession(
    UserProvider userProvider,
    PlanProvider planProvider,
    NavigatorState navigator,
  ) async {
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  DateTime? _insertAnchorAbove(int index, Activity selected) {
    if (index <= 0) return selected.startTime;
    final activities =
        Provider.of<PlanProvider>(context, listen: false).itineraryActivities;
    if (index > activities.length) return null;
    final above = activities[index - 1];
    return above.endTime ?? above.startTime;
  }

  /// Index in the loaded itinerary, which insert and the back-to-back chain use.
  /// The drawn list is sorted by start, so a row's on-screen index is not this.
  int _storedItineraryIndex(Activity activity) {
    final activities =
        Provider.of<PlanProvider>(context, listen: false).itineraryActivities;
    final id = activity.id;
    if (id != null && id.isNotEmpty) {
      final index = activities.indexWhere((item) => item.id == id);
      if (index >= 0) return index;
    }
    return activities.indexOf(activity);
  }

  Future<void> _addActivity({
    String? insertAfter,
    String? insertBefore,
    int? insertIndex,
    DateTime? initialStart,
    DateTime? initialEnd,
    DateTime? aboveInstant,
    String? initialZone,
    bool useDefaultStart = true,
  }) async {
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final rows = planProvider.itineraryActivities;
    final planZone = _shownPlan(planProvider).timeZone;
    final previousStart = useDefaultStart ? _defaultActivityStart(rows) : null;
    final openingStart = useDefaultStart
        ? (previousStart ??
            defaultChainStart(
              existingStarts: const [],
              planTimeZone: planZone,
            ))
        : initialStart;
    final openingAbove = useDefaultStart ? previousStart : aboveInstant;
    final fallbackStart = defaultChainStart(
      existingStarts: [
        for (final row in rows) row.startTime ?? row.endTime,
      ],
      planTimeZone: planZone,
    );
    final openingEnd = useDefaultStart
        ? (previousStart == null ? openingStart : null)
        : (initialEnd ?? initialStart);
    var openingZone = initialZone?.trim() ?? '';
    if (openingZone.isEmpty && useDefaultStart && rows.isNotEmpty) {
      final previous = rows.last;
      final storedType = previous.typeLabel.trim().toLowerCase();
      if (storedType == 'flight' || previous.type.name == 'flight') {
        openingZone = _activityEndZone(previous, _shownPlan(planProvider).timeZone);
      }
    }
    final draft = await showDialog<_ActivityFields>(
      context: context,
      builder: (context) => _ActivityFormDialog(
        title: 'Add activity',
        actionLabel: 'Add',
        planId: widget.plan.id,
        planTimeZone: _shownPlan(planProvider).timeZone,
        planDestination: _shownPlan(planProvider).destination,
        initialStart: openingStart,
        initialEnd: openingEnd,
        aboveInstant: openingAbove,
        fallbackStart: fallbackStart,
        initialZone: openingZone.isEmpty ? null : openingZone,
      ),
    );
    if (draft == null || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.createActivity(
      planId: widget.plan.id,
      name: draft.name,
      type: draft.type,
      startTime: draft.start!,
      endTime: draft.end!,
      timeZone: draft.timeZone,
      startTimeZone: draft.startTimeZone,
      endTimeZone: draft.endTimeZone,
      location: draft.location,
      googlePlaceId: draft.googlePlaceId,
      details: draft.details,
      bookingReference: draft.bookingReference,
      cost: draft.cost,
      costType: draft.costType,
      gate: draft.gate,
      baggageClaim: draft.baggageClaim,
      roomNumber: draft.roomNumber,
      origin: draft.origin,
      originCountry: draft.originCountry,
      destination: draft.destination,
      confirmation: draft.confirmation,
      durationMinutes: draft.durationMinutes,
      legs: draft.legs,
      insertAfter: insertAfter,
      insertBefore: insertBefore,
      insertIndex: insertIndex,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: planProvider.writeMessage ?? 'Upgrade to Plus to edit this plan.',
        token: userProvider.token,
      );
      return;
    }
    if (status != 201) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not add activity')),
      );
    }
  }

  Plan _shownPlan(PlanProvider planProvider) {
    for (final plan in planProvider.plans) {
      if (plan.id == widget.plan.id) return plan;
    }
    return _plan;
  }

  Future<void> _openAttachments(Activity activity) async {
    final activityId = activity.id;
    if (activityId == null || activityId.isEmpty) return;
    final name = activity.name.trim();
    await showDialog<void>(
      context: context,
      builder: (context) {
        final available = MediaQuery.sizeOf(context).width - 80;
        final width = available < 440
            ? (available < 0 ? 0.0 : available)
            : 440.0;
        return AlertDialog(
          title: Text(name.isEmpty ? 'Attachments' : name),
          content: SizedBox(
            width: width,
            child: ActivityAttachmentsSection(
              activityId: activityId,
              planId: widget.plan.id,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _openActivityEdit(Activity activity) async {
    final activityId = activity.id;
    if (activityId == null || activityId.isEmpty) return;
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final activities = planProvider.itineraryActivities;
    final index = activities.indexWhere((item) => item.id == activityId);
    DateTime? chainStart;
    if (index > 0 && activity.startTime == null) {
      chainStart = _shownActivityTimes(activities)[index].start;
    }
    final drawn = activitiesByUtcStart(activities);
    final drawnIndex = drawn.indexWhere((item) => item.id == activityId);
    DateTime? aboveInstant;
    if (drawnIndex > 0) {
      final prior = drawn[drawnIndex - 1];
      aboveInstant = prior.endTime ?? prior.startTime;
    }
    _presence?.editing(widget.plan.id, activityId);
    try {
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (context) => _ActivityFormDialog(
            title: 'Edit activity',
            actionLabel: 'Save',
            activity: activity,
            planId: widget.plan.id,
            planTimeZone: _shownPlan(planProvider).timeZone,
            planDestination: _shownPlan(planProvider).destination,
            chainStart: chainStart,
            aboveInstant: aboveInstant,
            fallbackStart: defaultChainStart(
              existingStarts: [
                for (final row in activities) row.startTime ?? row.endTime,
              ],
              planTimeZone: _shownPlan(planProvider).timeZone,
            ),
          ),
        ),
      );
    } finally {
      _presence?.idle(widget.plan.id);
    }
  }

  bool _applyingOrder = false;

  Future<void> _reorderActivities(int oldIndex, int newIndex) async {
    if (_applyingOrder) return;
    if (oldIndex == newIndex) return;
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final ordered = activitiesByUtcStart(planProvider.itineraryActivities);
    if (oldIndex < 0 || oldIndex >= ordered.length || newIndex < 0 || newIndex >= ordered.length) {
      return;
    }
    final moved = ordered.removeAt(oldIndex);
    if (moved.linked) return;
    ordered.insert(newIndex, moved);
    final activityId = moved.id;
    if (activityId == null || activityId.isEmpty) return;
    final activityIds = <String>[];
    for (final activity in ordered) {
      final id = activity.id;
      if (id == null || id.isEmpty) return;
      activityIds.add(id);
    }
    _applyingOrder = true;
    try {
      final status = await planProvider.moveActivity(
        planId: widget.plan.id,
        activityId: activityId,
        activityIds: activityIds,
        token: userProvider.token,
      );
      if (!mounted) return;
      if (status == 401) {
        await _endSession(userProvider, planProvider, navigator);
        return;
      }
      if (status == 403) {
        messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
        return;
      }
      if (status != 200) {
        messenger.showSnackBar(
          const SnackBar(content: Text('Could not move activity')),
        );
      }
    } finally {
      _applyingOrder = false;
    }
  }

  Future<void> _printPlan(Plan plan) async {
    final options = await showDialog<_PrintPlanOptions>(
      context: context,
      builder: (context) => const _PrintOrientationDialog(),
    );
    if (options == null || !mounted) return;
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final activities = planProvider.itineraryActivities;
    var progressShown = false;
    if (options.includeMaps) {
      progressShown = true;
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => const Center(child: CircularProgressIndicator()),
      );
    }
    try {
      final mapsByPlace = <String, Uint8List>{};
      if (options.includeMaps) {
        for (final activity in activities) {
          final placeId = activity.googlePlaceId.trim();
          if (placeId.isEmpty || mapsByPlace.containsKey(placeId)) continue;
          final result = await planProvider.fetchPlanPlaceMap(
            planId: plan.id,
            placeId: placeId,
            token: userProvider.token,
          );
          if (!mounted) return;
          if (result.status == 401 || result.status == 403) {
            logger.w('Place map GET status ${result.status}');
          }
          if (result.status == 401) {
            if (progressShown) navigator.pop();
            await _endSession(userProvider, planProvider, navigator);
            return;
          }
          final image = result.bytes;
          if (image != null && image.isNotEmpty) {
            mapsByPlace[placeId] = image;
          }
        }
      }
      final shownTimes = _shownActivityTimes(activities);
      final dayHeaders = _dayHeaders(shownTimes, plan.timeZone);
      final storedRole = planProvider.viewerStoredRole(
        plan.id,
        userProvider.currentUserId,
      );
      final hiddenFields = _guestHiddenFields(plan, storedRole);
      final rows = <PlanPdfRow>[
        for (var index = 0; index < activities.length; index++)
          _pdfActivityRow(
            activities[index],
            shownTimes[index],
            dayHeaders[index],
            plan.timeZone,
            hiddenFields: hiddenFields,
            mapImage: mapsByPlace[activities[index].googlePlaceId.trim()],
          ),
      ];
      final bytes = await buildPlanPdf(
        name: plan.name,
        destination: plan.destination,
        start: formatPlanDate(plan.startDate),
        end: formatPlanDate(plan.endDate),
        rows: rows,
        landscape: options.landscape,
        showDestination: !hiddenFields.contains('destination'),
      );
      if (progressShown && mounted) navigator.pop();
      progressShown = false;
      await Printing.sharePdf(
        bytes: bytes,
        filename: planPdfFilename(plan.name),
      );
    } catch (_) {
      if (progressShown && mounted) navigator.pop();
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not print plan')),
      );
    }
  }

  Future<void> _resortByStartTime() async {
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.resortItineraryByStartTime(
      planId: widget.plan.id,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (status != 200) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not re-sort activities')),
      );
    }
  }

  Widget _itineraryDayHeader(String label) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 8),
      child: Text(
        label,
        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
      ),
    );
  }

  Widget _itineraryActivityList({
    required List<Activity> activities,
    required List<_ShownActivityTimes> shownTimes,
    required List<String?> dayHeaders,
    required String planZone,
    required bool canChange,
    required Set<String> hiddenFields,
  }) {
    if (!canChange) {
      return Column(
        children: [
          for (var index = 0; index < activities.length; index++)
            _activityBlock(
              blockKey: ValueKey('guest-$index'),
              activity: activities[index],
              times: shownTimes[index],
              dayHeader: dayHeaders[index],
              planZone: planZone,
              canChange: false,
              hiddenFields: hiddenFields,
            ),
        ],
      );
    }
    return ReorderableListView.builder(
      shrinkWrap: true,
      primary: false,
      physics: const NeverScrollableScrollPhysics(),
      buildDefaultDragHandles: false,
      itemCount: activities.length,
      onReorderItem: (oldIndex, newIndex) {
        _reorderActivities(oldIndex, newIndex);
      },
      itemBuilder: (context, index) {
        final activity = activities[index];
        final activityId = activity.id;
        return _activityBlock(
          blockKey: ValueKey(
            activityId == null || activityId.isEmpty
                ? 'activity-$index'
                : activityId,
          ),
          activity: activity,
          times: shownTimes[index],
          dayHeader: dayHeaders[index],
          planZone: planZone,
          canChange: true,
          hiddenFields: hiddenFields,
          dragIndex: index,
        );
      },
    );
  }

  Widget _itineraryDaySection({
    required PlanItineraryDay day,
    required List<int> indexes,
    required List<Activity> activities,
    required List<_ShownActivityTimes> shownTimes,
    required String planZone,
    required bool canChange,
    required Set<String> hiddenFields,
  }) {
    final blocks = <Widget>[_itineraryDayHeader(day.label)];
    if (indexes.isEmpty) {
      blocks.add(
        const Padding(
          padding: EdgeInsets.only(bottom: 8),
          child: Text('No activities defined for this day'),
        ),
      );
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: blocks,
      );
    }
    if (!canChange) {
      for (final index in indexes) {
        blocks.add(
          _activityBlock(
            blockKey: ValueKey('guest-$index'),
            activity: activities[index],
            times: shownTimes[index],
            dayHeader: null,
            planZone: planZone,
            canChange: false,
            hiddenFields: hiddenFields,
          ),
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: blocks,
      );
    }
    final start = indexes.first;
    blocks.add(
      ReorderableListView.builder(
        key: ValueKey('day-${day.number}'),
        shrinkWrap: true,
        primary: false,
        physics: const NeverScrollableScrollPhysics(),
        buildDefaultDragHandles: false,
        itemCount: indexes.length,
        onReorderItem: (oldIndex, newIndex) {
          _reorderActivities(start + oldIndex, start + newIndex);
        },
        itemBuilder: (context, localIndex) {
          final index = indexes[localIndex];
          final activity = activities[index];
          final activityId = activity.id;
          return _activityBlock(
            blockKey: ValueKey(
              activityId == null || activityId.isEmpty
                  ? 'activity-$index'
                  : activityId,
            ),
            activity: activity,
            times: shownTimes[index],
            dayHeader: null,
            planZone: planZone,
            canChange: true,
            hiddenFields: hiddenFields,
            dragIndex: localIndex,
          );
        },
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: blocks,
    );
  }

  Widget _editingHint(String? activityId) {
    if (activityId == null || activityId.isEmpty) return const SizedBox.shrink();
    final self =
        Provider.of<UserProvider>(context, listen: false).currentUserId ??
        _selfId;
    final names = <String>[
      for (final user in _viewers)
        if (user.userId != self && user.activityId == activityId) user.name,
    ];
    if (names.isEmpty) return const SizedBox.shrink();
    final label = names.length == 1
        ? '${names.first} is editing'
        : '${names.join(', ')} are editing';
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontStyle: FontStyle.italic,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }

  Widget _activityBlock({
    required Key blockKey,
    required Activity activity,
    required _ShownActivityTimes times,
    required String? dayHeader,
    required String planZone,
    required bool canChange,
    required Set<String> hiddenFields,
    int? dragIndex,
  }) {
    final activityId = activity.id;
    final startZone = _activityStartZone(activity, planZone);
    final endZone = _activityEndZone(activity, planZone);
    final cardLines = _activityCardContent(
      activity,
      times,
      planZone,
      hiddenFields: hiddenFields,
    );
    return Column(
      key: blockKey,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (dayHeader != null)
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 8),
            child: Text(
              dayHeader,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
          ),
        Card(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                LayoutBuilder(
                  builder: (context, constraints) {
                    final narrow = constraints.maxWidth < 600;
                    final name = Text(
                      activity.name.trim(),
                      maxLines: narrow ? null : 1,
                      overflow: narrow ? null : TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w500,
                      ),
                    );
                    final actions = <Widget>[
                      if (_activityDirectionsUri(activity) != null)
                        IconButton(
                          tooltip: 'Directions',
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.map),
                          onPressed: () => _openDirections(activity),
                        ),
                      if (activityId != null && activityId.isNotEmpty) ...[
                        IconButton(
                          tooltip: 'Attachments',
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.attach_file),
                          onPressed: () => _openAttachments(activity),
                        ),
                        IconButton(
                          tooltip: 'History',
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.history),
                          onPressed: () => _openActivityHistory(activity),
                        ),
                        if (canChange && !activity.linked && !activity.poll)
                          PopupMenuButton<String>(
                            tooltip: 'Poll',
                            padding: EdgeInsets.zero,
                            icon: const Icon(Icons.poll),
                            onSelected: (value) {
                              if (value == 'poll') _startPoll(activity);
                            },
                            itemBuilder: (context) => const [
                              PopupMenuItem(
                                value: 'poll',
                                child: Text('Poll'),
                              ),
                            ],
                          ),
                      ],
                      if (canChange &&
                          !activity.linked &&
                          dragIndex != null &&
                          activityId != null &&
                          activityId.isNotEmpty) ...[
                        IconButton(
                          tooltip: 'Insert above',
                          visualDensity: VisualDensity.compact,
                          icon: const _PlusArrowIcon(up: true),
                          onPressed: () {
                            final storedIndex = _storedItineraryIndex(activity);
                            final atTop = storedIndex <= 0;
                            final rows = Provider.of<PlanProvider>(
                              context,
                              listen: false,
                            ).itineraryActivities;
                            final anchor = atTop
                                ? defaultChainStart(
                                    existingStarts: [
                                      for (final row in rows)
                                        row.startTime ?? row.endTime,
                                    ],
                                    planTimeZone: planZone,
                                  )
                                : _insertAnchorAbove(storedIndex, activity);
                            final zone = atTop && planZone.trim().isNotEmpty
                                ? planZone
                                : startZone;
                            _addActivity(
                              insertBefore: activityId,
                              insertIndex: storedIndex,
                              initialStart: anchor,
                              initialEnd: anchor,
                              aboveInstant: atTop ? null : anchor,
                              initialZone: zone,
                              useDefaultStart: false,
                            );
                          },
                        ),
                        IconButton(
                          tooltip: 'Insert below',
                          visualDensity: VisualDensity.compact,
                          icon: const _PlusArrowIcon(up: false),
                          onPressed: () {
                            final storedIndex = _storedItineraryIndex(activity);
                            final anchor =
                                activity.endTime ?? activity.startTime;
                            _addActivity(
                              insertAfter: activityId,
                              insertIndex: storedIndex < 0
                                  ? null
                                  : storedIndex + 1,
                              initialStart: anchor,
                              initialEnd: anchor,
                              aboveInstant: anchor,
                              initialZone: endZone,
                              useDefaultStart: false,
                            );
                          },
                        ),
                        IconButton(
                          tooltip: 'Edit activity',
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.edit),
                          onPressed: () => _openActivityEdit(activity),
                        ),
                      ],
                    ];
                    final dragHandle = dragIndex != null && !activity.linked
                        ? ReorderableDragStartListener(
                            index: dragIndex,
                            child: const Tooltip(
                              message: 'Reorder activity',
                              child: Icon(Icons.drag_handle),
                            ),
                          )
                        : null;
                    if (narrow) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          name,
                          if (dragHandle != null || actions.isNotEmpty)
                            Row(
                              children: [
                                if (dragHandle != null) dragHandle,
                                ...actions,
                              ],
                            ),
                        ],
                      );
                    }
                    return Row(
                      children: [
                        if (dragHandle != null) dragHandle,
                        Expanded(child: name),
                        ...actions,
                      ],
                    );
                  },
                ),
                _editingHint(activityId),
                _itineraryWarnings(activity),
                if (activityId != null && activityId.isNotEmpty)
                  _activityReactionRow(
                    activity,
                    canChange: canChange,
                  ),
                if (cardLines.above.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: cardLines.above,
                  ),
                const Padding(
                  padding: EdgeInsets.only(top: 8, bottom: 4),
                  child: Divider(),
                ),
                if (cardLines.below.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: cardLines.below,
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _finishReactionResult(
    ActivityReactionResult result,
    ScaffoldMessengerState messenger,
    UserProvider userProvider,
    PlanProvider planProvider,
    NavigatorState navigator,
  ) async {
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result.status != 200) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not save the vote')),
      );
    }
  }

  Future<void> _vote(Activity activity, String type) async {
    final activityId = activity.id;
    if (activityId == null || activityId.isEmpty) return;
    if (_reactionBusy.contains(activityId)) return;
    setState(() => _reactionBusy.add(activityId));
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final mine = planProvider.reactionsFor(activityId).mine(type);
    final result = mine
        ? await planProvider.clearActivityReaction(
            activityId: activityId,
            type: type,
            token: userProvider.token,
          )
        : await planProvider.setActivityReaction(
            activityId: activityId,
            type: type,
            token: userProvider.token,
          );
    if (!mounted) return;
    setState(() => _reactionBusy.remove(activityId));
    await _finishReactionResult(
      result,
      messenger,
      userProvider,
      planProvider,
      navigator,
    );
  }

  Future<void> _startPoll(Activity activity) async {
    final activityId = activity.id;
    if (activityId == null || activityId.isEmpty) return;
    if (activity.poll || activity.linked) return;
    if (_reactionBusy.contains(activityId)) return;
    setState(() => _reactionBusy.add(activityId));
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.startActivityPoll(
      activityId: activityId,
      token: userProvider.token,
    );
    if (!mounted) return;
    setState(() => _reactionBusy.remove(activityId));
    await _finishReactionResult(
      result,
      messenger,
      userProvider,
      planProvider,
      navigator,
    );
  }

  Widget _activityReactionRow(Activity activity, {required bool canChange}) {
    final activityId = activity.id ?? '';
    final summary = Provider.of<PlanProvider>(context).reactionsFor(activityId);
    final busy = _reactionBusy.contains(activityId);
    final poll = activity.poll;
    final canStartPoll = canChange && !activity.linked && !poll;
    final buttons = poll
        ? [
            _reactionButton(
              activity: activity,
              type: 'yes',
              tooltip: 'Yes',
              label: 'Yes',
              count: summary.count('yes'),
              mine: summary.mine('yes'),
              busy: busy,
            ),
            _reactionButton(
              activity: activity,
              type: 'no',
              tooltip: 'No',
              label: 'No',
              count: summary.count('no'),
              mine: summary.mine('no'),
              busy: busy,
            ),
            _reactionButton(
              activity: activity,
              type: 'maybe',
              tooltip: 'Maybe',
              label: 'Maybe',
              count: summary.count('maybe'),
              mine: summary.mine('maybe'),
              busy: busy,
            ),
          ]
        : [
            _reactionButton(
              activity: activity,
              type: 'up',
              tooltip: 'Thumbs up',
              icon: summary.mine('up')
                  ? Icons.thumb_up
                  : Icons.thumb_up_outlined,
              count: summary.count('up'),
              mine: summary.mine('up'),
              busy: busy,
              onLongPress: canStartPoll ? () => _startPoll(activity) : null,
            ),
            _reactionButton(
              activity: activity,
              type: 'down',
              tooltip: 'Thumbs down',
              icon: summary.mine('down')
                  ? Icons.thumb_down
                  : Icons.thumb_down_outlined,
              count: summary.count('down'),
              mine: summary.mine('down'),
              busy: busy,
              onLongPress: canStartPoll ? () => _startPoll(activity) : null,
            ),
          ];
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: GestureDetector(
        onLongPress: canStartPoll ? () => _startPoll(activity) : null,
        child: Wrap(spacing: 4, runSpacing: 4, children: buttons),
      ),
    );
  }

  Widget _reactionButton({
    required Activity activity,
    required String type,
    required String tooltip,
    required int count,
    required bool mine,
    required bool busy,
    IconData? icon,
    String? label,
    VoidCallback? onLongPress,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Tooltip(
      message: mine ? '$tooltip, your vote, $count' : '$tooltip, $count',
      child: TextButton(
        style: TextButton.styleFrom(
          visualDensity: VisualDensity.compact,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          minimumSize: Size.zero,
          backgroundColor: mine ? scheme.primaryContainer : null,
          foregroundColor: mine ? scheme.onPrimaryContainer : scheme.onSurface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        ),
        onPressed: busy ? null : () => _vote(activity, type),
        onLongPress: busy ? null : onLongPress,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) Icon(icon, size: 16),
            if (icon != null) const SizedBox(width: 4),
            if (label != null) Text(label),
            if (label != null) const SizedBox(width: 4),
            Text('$count'),
          ],
        ),
      ),
    );
  }

  Widget _itineraryWarnings(Activity activity) {
    final warnings = Provider.of<PlanProvider>(context).warningsFor(activity.id);
    if (warnings.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final warning in warnings)
            _itineraryWarningButton(
              icon: Icons.warning_amber_outlined,
              label: warning.message,
              detail: warning.message,
            ),
        ],
      ),
    );
  }

  Widget _itineraryWarningButton({
    required IconData icon,
    required String label,
    required String detail,
  }) {
    final color = Colors.deepOrange.shade800;
    return InkWell(
      onTap: () {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(detail)),
        );
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                label,
                style: TextStyle(color: color, fontSize: 13),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openActivityHistory(Activity activity) async {
    final activityId = activity.id;
    if (activityId == null || activityId.isEmpty) return;
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final storedRole = planProvider.viewerStoredRole(
      widget.plan.id,
      userProvider.currentUserId,
    );
    final restored = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (context) => ActivityHistoryScreen(
          activityId: activityId,
          canRestore: canAddActivity(storedRole) &&
              !(Provider.of<UserProvider>(context, listen: false)
                      .planAccess
                      ?.readOnly ??
                  false),
        ),
      ),
    );
    if (restored == true && mounted) await _load();
  }

  Future<void> _openDirections(Activity activity) async {
    final uri = _activityDirectionsUri(activity);
    if (uri == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened && mounted) {
        messenger.showSnackBar(
          const SnackBar(content: Text('Could not open directions')),
        );
      }
    } catch (_) {
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not open directions')),
      );
    }
  }

  Future<void> _archivePlan(Plan plan) async {
    final descriptionController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Archive ${plan.name}?'),
        content: TextField(
          controller: descriptionController,
          maxLength: 500,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Description'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Archive'),
          ),
        ],
      ),
    );
    final description = descriptionController.text.trim();
    descriptionController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.archivePlan(
      planId: plan.id,
      description: description,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 200) {
      await userProvider.loadPlanAccess();
      if (!mounted) return;
      navigator.pop();
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(planProvider.writeMessage ?? 'Could not archive this plan'),
      ),
    );
  }

  Future<void> _copyPlan(Plan plan) async {
    final nameController = TextEditingController(text: 'Copy of ${plan.name}');
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Copy plan'),
        content: TextField(
          controller: nameController,
          decoration: const InputDecoration(labelText: 'Name'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Copy'),
          ),
        ],
      ),
    );
    final name = nameController.text.trim();
    nameController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.copyPlan(
      planId: plan.id,
      name: name,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to own more plans.',
        token: userProvider.token,
        pack: planProvider.upgradePack ?? 'plus_monthly',
        tierName: planProvider.upgradeTierName,
        showUpgrade: planProvider.upgradePack != null,
      );
      return;
    }
    final created = result.plan;
    if (result.status != 201 || created == null) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not copy this plan')),
      );
      return;
    }
    await userProvider.loadPlanAccess();
    if (!mounted) return;
    await navigator.push(
      MaterialPageRoute(
        builder: (context) => PlanDetailScreen(plan: created),
      ),
    );
  }

  Future<void> _saveAsTemplate(Plan plan) async {
    final nameController = TextEditingController(text: plan.name);
    final descriptionController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Save as template'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameController,
                decoration: const InputDecoration(labelText: 'Name'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: descriptionController,
                decoration: const InputDecoration(labelText: 'Description'),
                maxLines: 3,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    final name = nameController.text.trim();
    final description = descriptionController.text.trim();
    nameController.dispose();
    descriptionController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (name.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('Name is required.')));
      return;
    }
    final status = await planProvider.saveAsTemplate(
      planId: plan.id,
      name: name,
      description: description,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 201) {
      messenger.showSnackBar(const SnackBar(content: Text('Saved as template')));
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(planProvider.writeMessage ?? 'Could not save this template'),
      ),
    );
  }

  Future<void> _openPlanEdit(Plan plan, String? storedRole) async {
    final removed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (context) => _PlanEditScreen(
          plan: plan,
          canDelete: storedRole?.trim() == 'Owner' &&
              !(Provider.of<UserProvider>(context, listen: false)
                      .planAccess
                      ?.readOnly ??
                  false),
        ),
      ),
    );
    if (removed == true && mounted) Navigator.of(context).pop();
  }

  Future<void> _openAiEdit() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final result = await showModalBottomSheet<Object>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _AiEditSheet(planId: widget.plan.id),
    );
    if (!mounted || result == null) return;
    if (result == 'unauthorized') {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result == true) await _load();
  }

  bool _showLinkMyPlan(Plan plan) {
    if (plan.sourcePlanId.trim().isNotEmpty) return false;
    if (plan.id == widget.plan.id &&
        widget.plan.sourcePlanId.trim().isNotEmpty) {
      return false;
    }
    return true;
  }

  List<Activity> _linkChoices(List<Activity> activities) {
    return [
      for (final activity in activities)
        if (!activity.linked && (activity.id ?? '').isNotEmpty) activity,
    ];
  }

  Future<void> _linkMyPlan(Plan plan) async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final sourceId = plan.sourcePlanId.trim();
    final updating = sourceId.isNotEmpty;
    final List<Activity> choices;
    if (updating) {
      final read = await planProvider.readItinerary(
        planId: sourceId,
        token: userProvider.token,
      );
      if (!mounted) return;
      if (read.status == 401) {
        await _endSession(userProvider, planProvider, navigator);
        return;
      }
      if (read.status != 200) {
        messenger.showSnackBar(
          SnackBar(content: Text(read.error ?? 'Could not load activities')),
        );
        return;
      }
      choices = _linkChoices(read.activities);
    } else {
      choices = _linkChoices(planProvider.itineraryActivities);
    }
    final selected = await showDialog<List<String>>(
      context: context,
      builder: (context) => _LinkActivitiesDialog(
        activities: choices,
        checkedIds: updating ? plan.linkedActivityIds.toSet() : const {},
        actionLabel: updating ? 'Save' : 'Link',
      ),
    );
    if (selected == null || !mounted) return;
    if (updating) {
      final result = await planProvider.updateLinkedActivities(
        planId: plan.id,
        activityIds: selected,
        token: userProvider.token,
      );
      if (!mounted) return;
      if (result.status == 401) {
        await _endSession(userProvider, planProvider, navigator);
        return;
      }
      if (result.status != 200) {
        messenger.showSnackBar(
          SnackBar(content: Text(result.error ?? 'Could not update the links')),
        );
        return;
      }
      final saved = result.plan;
      if (saved != null) _plan = saved;
      await _load();
      return;
    }
    final result = await planProvider.linkPersonalPlan(
      planId: plan.id,
      activityIds: selected,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result.status == 403) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Not allowed')),
      );
      return;
    }
    final created = result.plan;
    if (result.status != 201 || created == null) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not link a plan')),
      );
      return;
    }
    await navigator.push(
      MaterialPageRoute(
        builder: (context) => PlanDetailScreen(plan: created),
      ),
    );
  }

  Future<void> _openPeople(Plan plan) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => PlanPeopleScreen(plan: plan),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final planProvider = Provider.of<PlanProvider>(context);
    final shownPlan = _shownPlan(planProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(
          shownPlan.name,
          overflow: TextOverflow.ellipsis,
          maxLines: 1,
        ),
        actions: [
          TextButton(
            onPressed: () => _openPeople(shownPlan),
            child: const Text(
              'People',
              style: TextStyle(color: Colors.white),
            ),
          ),
        ],
      ),
      body: Consumer<PlanProvider>(
        builder: (context, planProvider, child) {
          if (!_loaded || planProvider.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (_status == 403) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  planProvider.itineraryError ??
                      'Not allowed to view this itinerary',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 20),
                ),
              ),
            );
          }
          if (_status != 200) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  planProvider.itineraryError ?? 'Could not load activities',
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }

          final viewer = context.watch<UserProvider>();
          final storedRole = planProvider.viewerStoredRole(
            widget.plan.id,
            viewer.currentUserId,
          );
          final shown = _shownPlan(planProvider);
          final roleText = storedRole == null
              ? null
              : planRoleLabel(shown.type, storedRole);
          final activities = activitiesByUtcStart(
            planProvider.itineraryActivities,
          );
          final readOnly = viewer.planAccess?.readOnly ?? false;
          final canChange = canAddActivity(storedRole);
          final trialLabel = viewer.planAccess?.trialEndsLabel;
          final shownTimes = _shownActivityTimes(activities);
          final daySpan = planItinerarySpan(
            starts: [for (final time in shownTimes) time.start],
            ends: [for (final time in shownTimes) time.end ?? time.start],
            planTimeZone: shown.timeZone,
          );
          final dayIndexes = planItineraryDayIndexes(
            starts: [for (final time in shownTimes) time.start],
            days: daySpan,
            planTimeZone: shown.timeZone,
          );
          final selectedDay = daySpan.any((day) => day.number == _itineraryDay)
              ? _itineraryDay
              : null;
          final hiddenFields = _guestHiddenFields(shown, storedRole);
          final dateLine = planHeaderDateLine(
            activities,
            planTimeZone: shown.timeZone,
          );
          final selfId = viewer.currentUserId ?? _selfId;
          final others = [
            for (final user in _viewers)
              if (selfId == null || user.userId != selfId) user,
          ];

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              shown.name,
                              style: const TextStyle(
                                fontSize: 24,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          TextButton(
                            onPressed: () => _printPlan(shown),
                            child: const Text('Print'),
                          ),
                          if (canChange)
                            TextButton(
                              onPressed: _resortByStartTime,
                              child: const Text('Re-sort'),
                            ),
                          if (canEditPlan(storedRole))
                            IconButton(
                              tooltip: 'Edit plan',
                              icon: const Icon(Icons.edit),
                              onPressed: () => _openPlanEdit(shown, storedRole),
                            ),
                        ],
                      ),
                      if (others.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          'Also viewing: ${others.map((user) => user.name).join(', ')}',
                          style: TextStyle(
                            fontSize: 13,
                            color: Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                      const SizedBox(height: 8),
                      if (trialLabel != null) ...[
                        Text(trialLabel),
                        const SizedBox(height: 8),
                      ],
                      if (_linkedSource != null) ...[
                        Text('Linked to: ${_linkedSource!.name}'),
                        for (final member in _linkedPlanners)
                          Text(
                            '${planRoleLabel(_linkedSource!.type, member.role)}: ${member.email.trim()}',
                          ),
                      ],
                      if (!hiddenFields.contains('destination'))
                        Text('Destination: ${shown.destination}'),
                      if (roleText != null) Text('Role: $roleText'),
                      if (!hiddenFields.contains('budget'))
                        Text('Budget: ${formatPlanBudget(shown.budget)}'),
                      if (!hiddenFields.contains('cost'))
                        Text(
                          'Activity costs: ${formatPlanMoney(_planActualCost(activities))}',
                        ),
                      if (dateLine != null) Text(dateLine),
                      Text('State: ${shown.planningState}'),
                      if (storedRole?.trim() == 'Owner' && !shown.isArchived)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Wrap(
                            children: [
                              TextButton(
                                onPressed: () => _copyPlan(shown),
                                child: const Text('Copy'),
                              ),
                              TextButton(
                                onPressed: () => _saveAsTemplate(shown),
                                child: const Text('Save as template'),
                              ),
                            ],
                          ),
                        ),
                      if (storedRole?.trim() == 'Owner')
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            onPressed: () => _archivePlan(shown),
                            child: const Text('Archive'),
                          ),
                        ),
                      if (_showLinkMyPlan(shown))
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            onPressed: () => _linkMyPlan(shown),
                            child: const Text('Link my plan'),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Expanded(
                    child: Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text(
                        'Itinerary',
                        style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ),
                  if (canChange)
                    Flexible(
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        children: [
                          TextButton(
                            onPressed: _openAiEdit,
                            child: const Text('AI edit'),
                          ),
                          if (!readOnly)
                            TextButton(
                              onPressed: () => _addActivity(),
                              child: const Text('Add activity'),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
              if (daySpan.isNotEmpty) ...[
                const SizedBox(height: 8),
                DropdownButton<int?>(
                  value: selectedDay,
                  isExpanded: true,
                  items: [
                    const DropdownMenuItem<int?>(
                      value: null,
                      child: Text('All'),
                    ),
                    for (final day in daySpan)
                      DropdownMenuItem<int?>(
                        value: day.number,
                        child: Text(day.label),
                      ),
                  ],
                  onChanged: (value) => setState(() => _itineraryDay = value),
                ),
              ],
              const SizedBox(height: 8),
              if (activities.isEmpty)
                const Center(
                  child: Text(
                    'No activities yet',
                    style: TextStyle(fontSize: 20),
                    textAlign: TextAlign.center,
                  ),
                )
              else if (daySpan.isEmpty)
                _itineraryActivityList(
                  activities: activities,
                  shownTimes: shownTimes,
                  dayHeaders: _dayHeaders(shownTimes, shown.timeZone),
                  planZone: shown.timeZone,
                  canChange: canChange,
                  hiddenFields: hiddenFields,
                )
              else
                for (var dayIndex = 0; dayIndex < daySpan.length; dayIndex++)
                  if (selectedDay == null ||
                      daySpan[dayIndex].number == selectedDay)
                    _itineraryDaySection(
                      day: daySpan[dayIndex],
                      indexes: dayIndexes[dayIndex],
                      activities: activities,
                      shownTimes: shownTimes,
                      planZone: shown.timeZone,
                      canChange: canChange,
                      hiddenFields: hiddenFields,
                    ),
            ],
          );
        },
      ),
    );
  }
}

String _pdfCostCell(Activity activity) {
  final cost = activity.cost;
  if (cost == null) return '';
  final money = formatPlanMoney(cost);
  // A missing cost is stored as 0, which formats as $0.00.
  if (money == formatPlanMoney(0)) return '';
  final mark = activity.costType == CostType.actual ? 'act' : 'est';
  return 'Cost($mark):\n$money';
}

Set<String> _guestHiddenFields(Plan plan, String? storedRole) {
  if (storedRole?.trim() != 'Guest') return const {};
  return plan.hiddenFields.toSet();
}

PlanPdfRow _pdfActivityRow(
  Activity activity,
  _ShownActivityTimes times,
  String? dayHeader,
  String planZone, {
  Set<String> hiddenFields = const {},
  Uint8List? mapImage,
}) {
  final storedType = activity.typeLabel.trim().isEmpty
      ? activity.type.name
      : activity.typeLabel.trim();
  return PlanPdfRow(
    dayHeader: dayHeader,
    type: activityTypeLabel(storedType),
    name: activity.name.trim(),
    start: _pdfClock(times.start, _activityStartZone(activity, planZone)),
    end: _pdfClock(times.end, _activityEndZone(activity, planZone)),
    duration: _durationLabel(activity),
    location: activity.location?.trim() ?? '',
    details: hiddenFields.contains('details') ? '' : _detailsLabel(activity),
    bookingReference: hiddenFields.contains('bookingReference')
        ? ''
        : activity.bookingReference?.trim() ?? '',
    origin: activity.origin?.trim() ?? '',
    originCountry: activity.originCountry?.trim() ?? '',
    destination: activity.destination?.trim() ?? '',
    confirmation: activity.confirmation?.trim() ?? '',
    cost: hiddenFields.contains('cost') ? '' : _pdfCostCell(activity),
    gate: activity.gate?.trim() ?? '',
    baggageClaim: activity.baggageClaim?.trim() ?? '',
    roomNumber: activity.roomNumber?.trim() ?? '',
    serviceProvider: activity.serviceProvider?.trim() ?? '',
    googlePlaceId: activity.googlePlaceId,
    mapImage: mapImage,
  );
}

String formatPlanBudget(num? amount) {
  if (amount == null) return 'not set';
  return formatPlanMoney(amount);
}

String formatPlanMoney(num amount) {
  return NumberFormat.currency(
    locale: 'en_US',
    symbol: r'$',
    decimalDigits: 2,
  ).format(amount);
}

double _planActualCost(List<Activity> activities) {
  var total = 0.0;
  for (final activity in activities) {
    final cost = activity.cost;
    if (cost != null) total += cost;
  }
  return total;
}

String _costBoxText(double? cost) {
  if (cost == null) return '';
  if (cost == cost.roundToDouble()) return cost.round().toString();
  return cost.toString();
}

String _storedCostType(Activity? activity) {
  if (activity?.costType == CostType.actual) return 'actual';
  return 'estimated';
}

class _ActivityFields {
  final String name;
  final String type;
  final DateTime? start;
  final DateTime? end;
  final String timeZone;
  final String startTimeZone;
  final String endTimeZone;
  final String location;
  final String googlePlaceId;
  final String details;
  final String bookingReference;
  final double? cost;
  final String costType;
  final String? gate;
  final String? baggageClaim;
  final String? roomNumber;
  final String? origin;
  final String? originCountry;
  final String? destination;
  final String? confirmation;
  final int? durationMinutes;
  final bool writeStart;
  final bool writeEnd;
  final bool writeDuration;
  final List<FlightLeg>? legs;

  const _ActivityFields({
    required this.name,
    required this.type,
    required this.start,
    required this.end,
    required this.timeZone,
    required this.startTimeZone,
    required this.endTimeZone,
    required this.location,
    required this.googlePlaceId,
    required this.details,
    required this.bookingReference,
    required this.cost,
    required this.costType,
    this.gate,
    this.baggageClaim,
    this.roomNumber,
    this.origin,
    this.originCountry,
    this.destination,
    this.confirmation,
    this.durationMinutes,
    this.writeStart = false,
    this.writeEnd = false,
    this.writeDuration = false,
    this.legs,
  });
}

class _ExtraLeg {
  final TextEditingController origin;
  final TextEditingController destination;
  final TextEditingController duration;
  DateTime? departure;
  DateTime? arrival;
  String originZone;
  String destinationZone;

  _ExtraLeg({
    String origin = '',
    String destination = '',
    String duration = '',
    this.departure,
    this.arrival,
    this.originZone = 'UTC',
    this.destinationZone = 'UTC',
  }) : origin = TextEditingController(text: origin),
       destination = TextEditingController(text: destination),
       duration = TextEditingController(text: duration);

  void dispose() {
    origin.dispose();
    destination.dispose();
    duration.dispose();
  }
}

String _storedActivityType(Activity? activity) {
  if (activity == null) return activityTypes.first;
  final stored = activity.typeLabel.trim().isEmpty
      ? activity.type.name
      : activity.typeLabel.trim();
  for (final type in activityTypes) {
    if (type.toLowerCase() == stored.toLowerCase()) return type;
  }
  return stored;
}

List<String> activityTypeChoices(String selected) {
  final sorted = [...activityTypes]..sort(
    (left, right) => activityTypeLabel(left).compareTo(activityTypeLabel(right)),
  );
  if (sorted.contains(selected)) return sorted;
  return [selected, ...sorted];
}

const _suggestPlaceTypes = <String, String>{
  'dining': 'Dining',
  'hotel': 'Hotel',
  'attraction': 'Attraction',
  'tour': 'Tour',
};

class _AiEditSheet extends StatefulWidget {
  final String planId;

  const _AiEditSheet({required this.planId});

  @override
  State<_AiEditSheet> createState() => _AiEditSheetState();
}

class _AiEditSheetState extends State<_AiEditSheet> {
  final _instructionController = TextEditingController();
  final List<AiCommandTurn> _history = [];
  var _loading = false;
  String? _error;
  String? _summary;
  Map<String, dynamic>? _proposal;

  @override
  void dispose() {
    _instructionController.dispose();
    super.dispose();
  }

  bool get _canApply {
    final action = _proposal?['action'];
    return action == 'add' || action == 'update' || action == 'delete';
  }

  Future<void> _propose() async {
    if (_loading) return;
    final instruction = _instructionController.text.trim();
    if (instruction.isEmpty) {
      setState(() => _error = 'Enter an instruction');
      return;
    }
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await planProvider.proposeAiCommand(
      planId: widget.planId,
      instruction: instruction,
      token: userProvider.token,
      history: [for (final turn in _history) turn.toJson()],
    );
    if (!mounted) return;
    if (result.status == 401) {
      Navigator.pop(context, 'unauthorized');
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to use AI.',
        token: userProvider.token,
      );
      setState(() => _loading = false);
      return;
    }
    if (result.status != 200 || result.proposal.isEmpty) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not propose an edit';
      });
      return;
    }
    final nextHistory = appendAiCommandHistory(
      _history,
      instruction,
      result.summary,
    );
    setState(() {
      _loading = false;
      _summary = result.summary;
      _proposal = result.proposal;
      _error = null;
      _history
        ..clear()
        ..addAll(nextHistory);
    });
    _instructionController.clear();
  }

  Future<void> _apply() async {
    final proposal = _proposal;
    if (_loading || proposal == null) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await planProvider.applyAiCommand(
      planId: widget.planId,
      proposal: proposal,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      Navigator.pop(context, 'unauthorized');
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to edit this plan.',
        token: userProvider.token,
      );
      setState(() => _loading = false);
      return;
    }
    if (result.status != 200 && result.status != 201) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not apply the edit';
      });
      return;
    }
    Navigator.pop(context, true);
  }

  String _proposalText(Map<String, dynamic> proposal) {
    final lines = <String>[];
    final action = (proposal['action'] ?? '').toString();
    if (action.isNotEmpty) lines.add('Action: $action');
    final activity = proposal['activity'];
    if (activity is Map) {
      _addLine(lines, 'Title', activity['title']);
      _addLine(lines, 'Type', activity['type']);
      _addLine(lines, 'Location', activity['location']);
      _addLine(lines, 'Start', activity['startTime']);
      _addLine(lines, 'End', activity['endTime']);
      _addLine(lines, 'Details', activity['details']);
      _addPlaceLine(lines, activity);
    }
    final changes = proposal['changes'];
    if (changes is Map) {
      _addLine(lines, 'Title', changes['title']);
      _addLine(lines, 'Start', changes['startTime']);
      _addLine(lines, 'End', changes['endTime']);
      _addLine(lines, 'Location', changes['location']);
      _addLine(lines, 'Details', changes['details']);
    }
    _addLine(lines, 'Activity', proposal['activityId']);
    final message = proposal['message'];
    if (message is String && message.trim().isNotEmpty) {
      lines.add(message.trim());
    }
    return lines.join('\n');
  }

  void _addPlaceLine(List<String> lines, Map activity) {
    final placeId = activity['googlePlaceId']?.toString().trim() ?? '';
    if (placeId.isEmpty) return;
    final name = activity['placeName']?.toString().trim() ?? '';
    lines.add(name.isEmpty ? 'Place: $placeId' : 'Place: $name');
  }

  String _confirmationText() {
    final summary = (_summary ?? '').trim();
    final activity = _proposal == null ? null : _proposal!['activity'];
    if (activity is! Map) return summary;
    final placeId = activity['googlePlaceId']?.toString().trim() ?? '';
    final name = activity['placeName']?.toString().trim() ?? '';
    if (placeId.isEmpty || name.isEmpty || summary.contains(name)) return summary;
    if (summary.isEmpty) return name;
    return '$summary\n$name';
  }

  void _addLine(List<String> lines, String label, Object? value) {
    final text = value?.toString().trim() ?? '';
    if (text.isEmpty) return;
    lines.add('$label: $text');
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final proposal = _proposal;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottom),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'AI edit',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            if (_history.isNotEmpty) ...[
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 140),
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final turn in _history)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text(
                            '${turn.role == 'assistant' ? 'AI' : 'You'}: ${turn.content}',
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (proposal != null) ...[
              if (_confirmationText().isNotEmpty)
                Text(
                  _confirmationText(),
                  style: const TextStyle(fontSize: 16),
                ),
              const SizedBox(height: 8),
              Text(_proposalText(proposal)),
              const SizedBox(height: 8),
              Row(
                children: [
                  if (_canApply)
                    TextButton(
                      onPressed: _loading ? null : _apply,
                      child: const Text('Apply'),
                    ),
                  TextButton(
                    onPressed: _loading ? null : () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
            ] else ...[
              const Text(
                'What should change?',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              const SizedBox(height: 4),
            ],
            TextField(
              controller: _instructionController,
              decoration: const InputDecoration(
                hintText: 'Add a dinner near the hotel on day 2',
              ),
              minLines: 2,
              maxLines: 4,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _propose(),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: _loading ? null : _propose,
                child: const Text('Propose'),
              ),
            ),
            if (_loading) const LinearProgressIndicator(),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Colors.red),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SuggestPlacesSheet extends StatefulWidget {
  final String planId;
  final String location;
  final String destination;
  final String initialType;

  const _SuggestPlacesSheet({
    required this.planId,
    required this.location,
    required this.destination,
    required this.initialType,
  });

  @override
  State<_SuggestPlacesSheet> createState() => _SuggestPlacesSheetState();
}

class _SuggestPlacesSheetState extends State<_SuggestPlacesSheet> {
  final _queryController = TextEditingController();
  String? _type;
  var _loading = false;
  String? _error;
  List<PlaceSuggestion> _places = const [];

  bool get _typeIsFixed =>
      _suggestPlaceTypes.containsKey(widget.initialType.trim().toLowerCase());

  @override
  void initState() {
    super.initState();
    final initial = widget.initialType.trim().toLowerCase();
    if (_suggestPlaceTypes.containsKey(initial)) _type = initial;
  }

  @override
  void dispose() {
    _queryController.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    if (_loading) return;
    final typed = _queryController.text.trim();
    final query = _typeIsFixed
        ? suggestLockedTypeQuery(
            typed: typed,
            activityType: _type,
            location: widget.location,
            destination: widget.destination,
          )
        : suggestSearchQuery(
            typed: typed,
            activityType: _type,
            location: widget.location,
            destination: widget.destination,
          );
    if (query == null) {
      setState(() {
        _places = const [];
        _error = 'Enter what you are looking for or pick a type';
      });
      return;
    }
    final supplied = widget.location.trim();
    final place = supplied.isNotEmpty ? supplied : widget.destination.trim();
    setState(() {
      _loading = true;
      _error = null;
      _places = const [];
    });
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final result = await planProvider.suggestActivityPlaces(
      planId: widget.planId,
      query: query,
      activityType: _type,
      location: _typeIsFixed || typed.isEmpty ? place : widget.location,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      Navigator.pop(context, 'unauthorized');
      return;
    }
    if (result.status == 402) {
      setState(() {
        _loading = false;
        _places = result.places;
        _error = null;
      });
      if (result.error == 'Insufficient AI credits') {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Not enough AI credits.')),
        );
        return;
      }
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to use AI.',
        token: userProvider.token,
      );
      return;
    }
    if (result.status != 200) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not suggest places';
      });
      return;
    }
    setState(() {
      _loading = false;
      _places = result.places;
      _error = result.places.isEmpty ? 'No places found' : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.7,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Suggest a place',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            const Text(
              'What are you looking for?',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 4),
            TextField(
              controller: _queryController,
              decoration: const InputDecoration(
                hintText: 'Type a place or a kind of place',
              ),
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _search(),
            ),
            const SizedBox(height: 8),
            if (!_typeIsFixed) ...[
              Wrap(
                spacing: 8,
                children: [
                  for (final entry in _suggestPlaceTypes.entries)
                    FilterChip(
                      label: Text(entry.value),
                      selected: _type == entry.key,
                      onSelected: (selected) {
                        setState(() => _type = selected ? entry.key : null);
                      },
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: _loading ? null : _search,
                child: const Text('Find places'),
              ),
            ),
            if (_loading) const LinearProgressIndicator(),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Colors.red),
                ),
              ),
            Expanded(
              child: ListView(
                children: [
                  for (final place in _places)
                    ListTile(
                      title: Text(place.name),
                      subtitle: Text(_suggestionLines(place)),
                      onTap: () => Navigator.pop(context, place),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _suggestionLines(PlaceSuggestion place) {
    return suggestionListSubtitle(
      address: place.address,
      summary: place.summary,
    );
  }
}

class _ActivityFormDialog extends StatefulWidget {
  final String title;
  final String actionLabel;
  final Activity? activity;
  final String? planId;
  final String planTimeZone;
  final String planDestination;
  final DateTime? initialStart;
  final DateTime? initialEnd;
  final DateTime? chainStart;
  final DateTime? aboveInstant;
  final DateTime? fallbackStart;
  final String? initialZone;

  const _ActivityFormDialog({
    required this.title,
    required this.actionLabel,
    this.activity,
    this.planId,
    this.planTimeZone = '',
    this.planDestination = '',
    this.initialStart,
    this.initialEnd,
    this.chainStart,
    this.aboveInstant,
    this.fallbackStart,
    this.initialZone,
  });

  bool get isScreen => activity != null;

  @override
  State<_ActivityFormDialog> createState() => _ActivityFormDialogState();
}

class _ActivityFormDialogState extends State<_ActivityFormDialog> {
  late final TextEditingController _nameController;
  late final TextEditingController _durationController;
  late final TextEditingController _locationController;
  late final TextEditingController _googlePlaceIdController;
  late final TextEditingController _placeSearchController;
  late final TextEditingController _detailsController;
  late final TextEditingController _bookingReferenceController;
  late final TextEditingController _confirmationController;
  late final TextEditingController _originController;
  late final TextEditingController _destinationController;
  late final TextEditingController _shuttleOriginController;
  late final TextEditingController _shuttleOriginCountryController;
  late final TextEditingController _shuttleDestinationController;
  late final TextEditingController _shuttleConfirmationController;
  late final TextEditingController _legDurationController;
  late final TextEditingController _costController;
  late String _costType;
  late final TextEditingController _gateController;
  late final TextEditingController _baggageController;
  late final TextEditingController _roomController;
  late String _type;
  late String _startZone;
  late String _endZone;
  bool _endZoneCustom = false;
  DateTime? _start;
  DateTime? _end;
  bool _startChanged = false;
  bool _endChanged = false;
  bool _parsingConfirmation = false;
  bool _askingToLeave = false;
  String? _error;
  Timer? _placeSearchTimer;
  int _placeSearchSeq = 0;
  String _placeSearchSeed = '';
  List<PlaceSuggestion> _placeSuggestions = const [];
  String? _placeSearchError;
  late final String _openedForm;
  final List<_ExtraLeg> _extraLegs = [];
  final List<_ExtraLeg> _retiredLegs = [];

  String _storedDurationText(Activity? activity) {
    if (activity == null) return '';
    final stored = activity.duration?.inMinutes;
    if (stored != null) return stored.toString();
    final start = activity.startTime;
    final end = activity.endTime;
    if (start == null || end == null) return '';
    return end.difference(start).inMinutes.toString();
  }

  @override
  void initState() {
    super.initState();
    final activity = widget.activity;
    _nameController = TextEditingController(text: activity?.name ?? '');
    _start = activity?.startTime ?? widget.chainStart ?? widget.initialStart;
    _end = activity?.endTime;
    if (activity != null &&
        activity.startTime == null &&
        activity.duration == null &&
        activity.endTime == null) {
      _end = widget.chainStart;
    } else if (activity != null &&
        activity.endTime == null &&
        activity.duration != null &&
        _start != null) {
      _end = _start!.add(activity.duration!);
    } else if (activity == null) {
      _end = widget.initialEnd;
    }
    _durationController = TextEditingController(text: _storedDurationText(activity));
    _locationController = TextEditingController(text: activity?.location ?? '');
    _googlePlaceIdController = TextEditingController(
      text: activity?.googlePlaceId ?? '',
    );
    final openingLocation = (activity?.location ?? '').trim();
    _placeSearchController = TextEditingController(text: openingLocation);
    _placeSearchSeed = openingLocation;
    if (openingLocation.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_typeUsesPlaceId(_type)) return;
        _onPlaceSearchChanged(_placeSearchController.text);
      });
    }
    _detailsController = TextEditingController(text: activity?.details ?? '');
    _bookingReferenceController = TextEditingController(
      text: (activity?.bookingReference ?? '').trim(),
    );
    _confirmationController = TextEditingController();
    _originController = TextEditingController();
    _destinationController = TextEditingController();
    _shuttleOriginController = TextEditingController(text: activity?.origin ?? '');
    _shuttleOriginCountryController = TextEditingController(
      text: activity?.originCountry ?? '',
    );
    _shuttleDestinationController = TextEditingController(
      text: activity?.destination ?? '',
    );
    _shuttleConfirmationController = TextEditingController(
      text: activity?.confirmation ?? '',
    );
    _legDurationController = TextEditingController();
    _costController = TextEditingController(text: _costBoxText(activity?.cost));
    _costType = _storedCostType(activity);
    _gateController = TextEditingController(text: activity?.gate ?? '');
    _baggageController = TextEditingController(text: activity?.baggageClaim ?? '');
    _roomController = TextEditingController(text: activity?.roomNumber ?? '');
    _type = _storedActivityType(activity);
    _startZone = _openingStartZone(activity);
    _endZone = _openingEndZone(activity, _startZone);
    _endZoneCustom = _endZone != _startZone;
    _loadStoredLegs(activity);
    _openedForm = _formSignature();
  }

  String _formToken(String value) => '${value.length}:$value;';

  String _clockToken(DateTime? value) {
    if (value == null) return _formToken('');
    return _formToken(value.toUtc().microsecondsSinceEpoch.toString());
  }

  String _formSignature() {
    final parts = <String>[
      _formToken(_nameController.text),
      _formToken(_durationController.text),
      _formToken(_locationController.text),
      _formToken(_googlePlaceIdController.text),
      _formToken(_detailsController.text),
      _formToken(_bookingReferenceController.text),
      _formToken(_confirmationController.text),
      _formToken(_originController.text),
      _formToken(_destinationController.text),
      _formToken(_shuttleOriginController.text),
      _formToken(_shuttleOriginCountryController.text),
      _formToken(_shuttleDestinationController.text),
      _formToken(_shuttleConfirmationController.text),
      _formToken(_legDurationController.text),
      _formToken(_costController.text),
      _formToken(_costType),
      _formToken(_gateController.text),
      _formToken(_baggageController.text),
      _formToken(_roomController.text),
      _formToken(_type),
      _formToken(_startZone),
      _formToken(_endZone),
      _clockToken(_start),
      _clockToken(_end),
    ];
    for (final leg in _extraLegs) {
      parts.addAll([
        _formToken(leg.origin.text),
        _formToken(leg.destination.text),
        _formToken(leg.duration.text),
        _clockToken(leg.departure),
        _clockToken(leg.arrival),
        _formToken(leg.originZone),
        _formToken(leg.destinationZone),
      ]);
    }
    return parts.join();
  }

  bool _formChanged() => _formSignature() != _openedForm;

  Future<void> _onLeaveAttempt() async {
    if (!mounted || _askingToLeave) return;
    if (!_formChanged()) {
      _askingToLeave = true;
      await Future<void>.value();
      if (!mounted) return;
      Navigator.pop(context);
      return;
    }
    _askingToLeave = true;
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Leave this activity?'),
        content: const Text('The unsaved changes will be dropped.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Stay'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Leave'),
          ),
        ],
      ),
    );
    _askingToLeave = false;
    if (!mounted) return;
    if (leave == true) Navigator.pop(context);
  }

  void _loadStoredLegs(Activity? activity) {
    if (activity == null || _type != 'flight') return;
    if (activity.legs.isEmpty) {
      _legDurationController.text = _durationTextFor(
        stored: activity.duration?.inMinutes,
        departure: _start,
        arrival: _end,
      );
      _applyDurationToArrival(
        minutesText: _legDurationController.text,
        departure: _start,
        assign: (arrival) => _end = arrival,
      );
      return;
    }
    final first = activity.legs.first;
    _originController.text = first.origin;
    _destinationController.text = first.destination;
    _start = first.departure;
    _end = first.arrival;
    final firstOrigin = first.originTimeZone.trim();
    final firstDestination = first.destinationTimeZone.trim();
    if (firstOrigin.isNotEmpty) _startZone = firstOrigin;
    if (firstDestination.isNotEmpty) _endZone = firstDestination;
    _endZoneCustom = _endZone != _startZone;
    _legDurationController.text = _durationTextFor(
      stored: first.durationMinutes,
      departure: first.departure,
      arrival: first.arrival,
    );
    _applyDurationToArrival(
      minutesText: _legDurationController.text,
      departure: _start,
      assign: (arrival) => _end = arrival,
    );
    for (final leg in activity.legs.skip(1)) {
      final originZone = leg.originTimeZone.trim();
      final destinationZone = leg.destinationTimeZone.trim();
      final durationText = _durationTextFor(
        stored: leg.durationMinutes,
        departure: leg.departure,
        arrival: leg.arrival,
      );
      var arrival = leg.arrival;
      final minutes = _wholeMinutes(durationText);
      final departure = leg.departure;
      if (minutes != null && departure != null) {
        arrival = departure.add(Duration(minutes: minutes));
      }
      _extraLegs.add(
        _ExtraLeg(
          origin: leg.origin,
          destination: leg.destination,
          duration: durationText,
          departure: leg.departure,
          arrival: arrival,
          originZone: originZone.isNotEmpty ? originZone : _startZone,
          destinationZone: destinationZone.isNotEmpty ? destinationZone : _endZone,
        ),
      );
    }
    _syncShownDuration();
  }

  String _durationTextFor({
    required int? stored,
    required DateTime? departure,
    required DateTime? arrival,
  }) {
    if (stored != null && stored >= 0) return stored.toString();
    if (departure != null && arrival != null && !arrival.isBefore(departure)) {
      return arrival.difference(departure).inMinutes.toString();
    }
    return '';
  }

  void _applyDurationToArrival({
    required String minutesText,
    required DateTime? departure,
    required void Function(DateTime arrival) assign,
  }) {
    final minutes = _wholeMinutes(minutesText);
    if (minutes == null || departure == null) return;
    assign(departure.add(Duration(minutes: minutes)));
  }

  String _planOrUtc() {
    final planZone = widget.planTimeZone.trim();
    if (planZone.isNotEmpty) return planZone;
    return 'UTC';
  }

  String _openingStartZone(Activity? activity) {
    if (activity != null) {
      final start = activity.startTimeZone.trim();
      if (start.isNotEmpty) return start;
      final origin = activity.originTimeZone?.trim() ?? '';
      if (origin.isNotEmpty) return origin;
      final stored = activity.timeZone.trim();
      if (stored.isNotEmpty) return stored;
    }
    final copied = widget.initialZone?.trim() ?? '';
    if (copied.isNotEmpty) return copied;
    return _planOrUtc();
  }

  String _openingEndZone(Activity? activity, String startZone) {
    if (activity == null) return startZone;
    final end = activity.endTimeZone.trim();
    if (end.isNotEmpty) return end;
    final destination = activity.destinationTimeZone?.trim() ?? '';
    if (destination.isNotEmpty) return destination;
    return startZone;
  }

  DateTime _instantFromWall(DateTime wall, String zone) {
    final clock = wall.toUtc();
    return instantFromWall(
      year: clock.year,
      month: clock.month,
      day: clock.day,
      hour: clock.hour,
      minute: clock.minute,
      zone: zone,
    );
  }

  @override
  void dispose() {
    _nameController.dispose();
    _durationController.dispose();
    _locationController.dispose();
    _placeSearchTimer?.cancel();
    _googlePlaceIdController.dispose();
    _placeSearchController.dispose();
    _detailsController.dispose();
    _bookingReferenceController.dispose();
    _confirmationController.dispose();
    _originController.dispose();
    _destinationController.dispose();
    _shuttleOriginController.dispose();
    _shuttleOriginCountryController.dispose();
    _shuttleDestinationController.dispose();
    _shuttleConfirmationController.dispose();
    _legDurationController.dispose();
    _costController.dispose();
    _gateController.dispose();
    _baggageController.dispose();
    _roomController.dispose();
    for (final leg in _extraLegs) {
      leg.dispose();
    }
    for (final leg in _retiredLegs) {
      leg.dispose();
    }
    super.dispose();
  }

  void _onStartZone(String zone) {
    if (zone == _startZone) return;
    setState(() {
      _startZone = zone;
      if (!_endZoneCustom) _endZone = zone;
      _error = null;
    });
  }

  void _onEndZone(String zone) {
    if (zone == _endZone) return;
    setState(() {
      _endZone = zone;
      _endZoneCustom = true;
      _error = null;
    });
  }

  void _setStart(DateTime instant) {
    final value = instant.toUtc();
    if (_usesFlightFields) {
      final minutes = _wholeMinutes(_legDurationController.text);
      setState(() {
        _start = value;
        _startChanged = true;
        _error = null;
        if (minutes != null) {
          _end = value.add(Duration(minutes: minutes));
          _endChanged = true;
        }
        _syncShownDuration();
      });
      return;
    }
    final typed = _wholeMinutes(_durationController.text);
    final previousStart = _start;
    final previousEnd = _end;
    var preserved = typed;
    if (preserved == null &&
        previousStart != null &&
        previousEnd != null &&
        !previousEnd.isBefore(previousStart)) {
      preserved = previousEnd.difference(previousStart).inMinutes;
    }
    setState(() {
      _start = value;
      _startChanged = true;
      _error = null;
      if (preserved != null) {
        _end = value.add(Duration(minutes: preserved));
        _endChanged = true;
      }
    });
  }

  void _setEnd(DateTime instant) {
    final value = instant.toUtc();
    if (_usesFlightFields) {
      setState(() {
        _end = value;
        _endChanged = true;
        _error = null;
        _syncShownDuration();
      });
      return;
    }
    setState(() {
      _end = value;
      _endChanged = true;
      _error = null;
      final start = _start;
      if (start != null) {
        _durationController.text = value.difference(start).inMinutes.toString();
      }
    });
  }

  void _clearStart() {
    setState(() {
      _start = null;
      _startChanged = true;
      _error = null;
    });
  }

  void _clearEnd() {
    setState(() {
      _end = null;
      _endChanged = true;
      if (!_usesFlightFields) _durationController.clear();
      _error = null;
    });
  }

  void _onDurationChanged(String text) {
    if (_usesFlightFields) return;
    final minutes = _wholeMinutes(text);
    final start = _start;
    if (minutes == null || start == null) {
      setState(() => _error = null);
      return;
    }
    setState(() {
      _end = start.add(Duration(minutes: minutes));
      _endChanged = true;
      _error = null;
    });
  }

  DateTime? get _spanEnd {
    if (_type == 'flight' && _extraLegs.isNotEmpty) {
      return _extraLegs.last.arrival;
    }
    return _end;
  }

  String _lastDestinationText() {
    if (_extraLegs.isNotEmpty) return _extraLegs.last.destination.text.trim();
    return _destinationController.text.trim();
  }

  String _lastDestinationZone() {
    if (_extraLegs.isNotEmpty) return _extraLegs.last.destinationZone;
    return _endZone;
  }

  void _syncShownDuration() {
    if (_durationController.text.trim().isNotEmpty) return;
    final start = _start;
    final end = _extraLegs.isEmpty ? _end : _extraLegs.last.arrival;
    if (start != null && end != null && !end.isBefore(start)) {
      _durationController.text = end.difference(start).inMinutes.toString();
    }
  }

  bool get _usesFlightFields => _type == 'flight';

  bool get _usesShuttleFields => _type == 'shuttle';

  bool get _usesRoutePlaces =>
      _type == 'shuttle' || _type == 'train' || _type == 'cruise';

  bool get _fillsFromConfirmation =>
      _usesFlightFields ||
      _usesRoutePlaces ||
      _type == 'hotel';

  bool get _usesRoom =>
      _type == 'hotel' || _type == 'ceremony' || _type == 'reception';

  List<FlightLeg> _collectedLegs() {
    return [
      FlightLeg(
        origin: _originController.text.trim(),
        originTimeZone: _startZone,
        departure: _start,
        destination: _destinationController.text.trim(),
        destinationTimeZone: _endZone,
        arrival: _end,
        durationMinutes: _wholeMinutes(_legDurationController.text),
      ),
      for (final leg in _extraLegs)
        FlightLeg(
          origin: leg.origin.text.trim(),
          originTimeZone: leg.originZone,
          departure: leg.departure,
          destination: leg.destination.text.trim(),
          destinationTimeZone: leg.destinationZone,
          arrival: leg.arrival,
          durationMinutes: _wholeMinutes(leg.duration.text),
        ),
    ];
  }

  void _addLeg() {
    final previous = _lastDestinationText();
    final previousZone = _lastDestinationZone();
    setState(() {
      _extraLegs.add(
        _ExtraLeg(
          origin: previous,
          originZone: previousZone,
          destinationZone: previousZone,
        ),
      );
      _startChanged = true;
      _endChanged = true;
      _syncFlightLocation();
      _syncShownDuration();
      _error = null;
    });
  }

  void _removeLeg(int index) {
    if (_extraLegs.isEmpty) return;
    setState(() {
      if (index <= 0) {
        final next = _extraLegs.removeAt(0);
        _originController.text = next.origin.text;
        _destinationController.text = next.destination.text;
        _start = next.departure;
        _end = next.arrival;
        _startZone = next.originZone;
        _endZone = next.destinationZone;
        _endZoneCustom = _endZone != _startZone;
        _legDurationController.text = next.duration.text;
        _applyDurationToArrival(
          minutesText: _legDurationController.text,
          departure: _start,
          assign: (arrival) => _end = arrival,
        );
        _retiredLegs.add(next);
      } else {
        _retiredLegs.add(_extraLegs.removeAt(index - 1));
      }
      _startChanged = true;
      _endChanged = true;
      _syncFlightLocation();
      _syncShownDuration();
      _error = null;
    });
  }

  void _setExtraDeparture(int index, DateTime instant) {
    final leg = _extraLegs[index];
    final minutes = _wholeMinutes(leg.duration.text);
    final departure = instant.toUtc();
    setState(() {
      leg.departure = departure;
      _startChanged = true;
      _error = null;
      if (minutes != null) {
        leg.arrival = departure.add(Duration(minutes: minutes));
        _endChanged = true;
      }
      _syncShownDuration();
    });
  }

  void _onLeg1DurationChanged(String text) {
    final minutes = _wholeMinutes(text);
    final departure = _start;
    setState(() {
      _error = null;
      if (minutes != null && departure != null) {
        _end = departure.add(Duration(minutes: minutes));
        _endChanged = true;
      }
      _syncShownDuration();
    });
  }

  void _onExtraDurationChanged(int index, String text) {
    final leg = _extraLegs[index];
    final minutes = _wholeMinutes(text);
    final departure = leg.departure;
    setState(() {
      _error = null;
      if (minutes != null && departure != null) {
        leg.arrival = departure.add(Duration(minutes: minutes));
        _endChanged = true;
      }
      _syncShownDuration();
    });
  }

  void _setExtraArrival(int index, DateTime instant) {
    setState(() {
      _extraLegs[index].arrival = instant.toUtc();
      _endChanged = true;
      _error = null;
      _syncShownDuration();
    });
  }

  void _onExtraOriginZone(int index, String zone) {
    if (_extraLegs[index].originZone == zone) return;
    setState(() {
      _extraLegs[index].originZone = zone;
      _error = null;
    });
  }

  void _onExtraDestinationZone(int index, String zone) {
    if (_extraLegs[index].destinationZone == zone) return;
    setState(() {
      _extraLegs[index].destinationZone = zone;
      _error = null;
    });
  }

  void _clearExtraDeparture(int index) {
    setState(() {
      _extraLegs[index].departure = null;
      _startChanged = true;
      _error = null;
      _syncShownDuration();
    });
  }

  void _clearExtraArrival(int index) {
    setState(() {
      _extraLegs[index].arrival = null;
      _endChanged = true;
      _error = null;
      _syncShownDuration();
    });
  }

  _ActivityFields? _fields() {
    if (_usesFlightFields) _syncFlightLocation();
    final name = _nameController.text.trim();
    final start = _start;
    final end = _spanEnd;
    if (_usesFlightFields) {
      final legDurations = <String>[
        _legDurationController.text,
        for (final leg in _extraLegs) leg.duration.text,
      ];
      for (final text in legDurations) {
        final trimmed = text.trim();
        if (trimmed.isNotEmpty && _wholeMinutes(trimmed) == null) {
          setState(() => _error = 'Enter duration as whole minutes');
          return null;
        }
      }
    }
    final typedDuration = _durationController.text.trim();
    var minutes = _wholeMinutes(typedDuration);
    if (typedDuration.isNotEmpty && minutes == null) {
      setState(() => _error = 'Enter duration as whole minutes');
      return null;
    }
    final editing = widget.isScreen;
    if (name.isEmpty || (!editing && (start == null || end == null))) {
      setState(() => _error = 'Enter a name, a start, and an end');
      return null;
    }
    if (start != null && end != null && end.isBefore(start)) {
      setState(() => _error = 'End time must not be before the start time');
      return null;
    }
    final costText = _costController.text.trim();
    double? cost;
    if (costText.isNotEmpty) {
      cost = double.tryParse(costText);
      if (cost == null) {
        setState(() => _error = 'Enter cost as a number');
        return null;
      }
      if (cost < 0) {
        setState(() => _error = 'Cost cannot be negative');
        return null;
      }
    }
    if (minutes == null && typedDuration.isEmpty && start != null && end != null) {
      final storedStart = widget.activity?.startTime;
      final storedEnd = widget.activity?.endTime;
      final userSetTimes = !editing || _startChanged || _endChanged;
      if (userSetTimes || (storedStart != null && storedEnd != null)) {
        minutes = end.difference(start).inMinutes;
      }
    }
    var writeDuration = minutes != null;
    if (editing && _endChanged && end == null) {
      minutes = null;
      writeDuration = true;
    }
    var writeStart = !editing || _startChanged;
    var writeEnd = !editing || _endChanged;
    if (_usesFlightFields) {
      writeStart = true;
      writeEnd = true;
      if (typedDuration.isNotEmpty) {
        minutes = _wholeMinutes(typedDuration);
        writeDuration = true;
      } else if (start != null && end != null && !end.isBefore(start)) {
        minutes = end.difference(start).inMinutes;
        writeDuration = true;
      } else {
        minutes = null;
        writeDuration = true;
      }
    }
    final savedEndZone = _usesFlightFields && _extraLegs.isNotEmpty
        ? _extraLegs.last.destinationZone
        : _endZone;
    return _ActivityFields(
      name: name,
      type: _type,
      start: writeStart ? start : null,
      end: writeEnd ? end : null,
      timeZone: _startZone,
      startTimeZone: _startZone,
      endTimeZone: savedEndZone,
      location: _locationController.text.trim(),
      googlePlaceId: _googlePlaceIdController.text.trim(),
      details: _detailsController.text.trim(),
      bookingReference: _bookingReferenceController.text.trim(),
      cost: cost,
      costType: _costType,
      gate: _usesFlightFields ? _gateController.text.trim() : null,
      baggageClaim: _usesFlightFields ? _baggageController.text.trim() : null,
      roomNumber: _usesRoom ? _roomController.text.trim() : null,
      origin: _usesRoutePlaces ? _shuttleOriginController.text.trim() : null,
      originCountry: _usesShuttleFields
          ? _shuttleOriginCountryController.text.trim()
          : null,
      destination: _usesRoutePlaces
          ? _shuttleDestinationController.text.trim()
          : null,
      confirmation: _fillsFromConfirmation
          ? _shuttleConfirmationController.text.trim()
          : null,
      durationMinutes: minutes,
      writeStart: writeStart,
      writeEnd: writeEnd,
      writeDuration: writeDuration,
      legs: _usesFlightFields ? _collectedLegs() : null,
    );
  }

  void _syncFlightLocation() {
    final origin = _originController.text.trim();
    final destination = _lastDestinationText();
    if (origin.isEmpty && destination.isEmpty) return;
    if (origin.isNotEmpty && destination.isNotEmpty) {
      _locationController.text = '$origin to $destination';
      return;
    }
    _locationController.text = origin.isNotEmpty ? origin : destination;
  }

  DateTime? _wallFromParsed(String raw, String zone, DateTime? existing) {
    final text = raw.trim();
    final timed = RegExp(
      r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$',
    ).firstMatch(text);
    final dated = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(text);
    final match = timed ?? dated;
    if (match == null) return null;
    final year = int.parse(match.group(1)!);
    final month = int.parse(match.group(2)!);
    final day = int.parse(match.group(3)!);
    var hour = 0;
    var minute = 0;
    if (timed != null) {
      hour = int.parse(timed.group(4)!);
      minute = int.parse(timed.group(5)!);
    } else if (existing != null) {
      final clock = clockInZone(existing, zone);
      hour = clock.hour;
      minute = clock.minute;
    }
    return _instantFromWall(DateTime.utc(year, month, day, hour, minute), zone);
  }

  void _applyConfirmation(Map<String, String> values) {
    final booking = values['bookingReference'];
    if (booking != null && booking.isNotEmpty) {
      _bookingReferenceController.text = booking;
    }
    final parsedName = values['name'];
    if (parsedName != null && parsedName.isNotEmpty) {
      _nameController.text = parsedName;
    }
    if (_fillsFromConfirmation) {
      final confirmation = values['confirmation'];
      if (confirmation != null && confirmation.isNotEmpty) {
        _shuttleConfirmationController.text = confirmation;
      }
    }
    if (_type == 'flight') {
      final origin = values['origin'];
      final destination = values['destination'];
      if (origin != null && origin.isNotEmpty) {
        _originController.text = origin;
      }
      if (destination != null && destination.isNotEmpty) {
        _destinationController.text = destination;
      }
      _syncFlightLocation();
      if (_nameController.text.trim().isEmpty) {
        final place = _locationController.text.trim();
        if (place.isNotEmpty) _nameController.text = place;
      }
    } else if (_usesRoutePlaces) {
      final origin = values['origin'];
      final destination = values['destination'];
      if (origin != null && origin.isNotEmpty) {
        _shuttleOriginController.text = origin;
      }
      if (destination != null && destination.isNotEmpty) {
        _shuttleDestinationController.text = destination;
      }
    }
    var filledStart = false;
    var filledEnd = false;
    final startText = values['start'];
    if (startText != null && startText.isNotEmpty) {
      final next = _wallFromParsed(startText, _startZone, _start);
      if (next != null) {
        _start = next;
        _startChanged = true;
        filledStart = true;
      }
    }
    final endText = values['end'];
    if (endText != null && endText.isNotEmpty) {
      final next = _wallFromParsed(endText, _endZone, _end);
      if (next != null) {
        _end = next;
        _endChanged = true;
        filledEnd = true;
      }
    }
    if (_type == 'flight' && (filledStart || filledEnd)) {
      if (!filledEnd && _end == null) {
        final minutes = _wholeMinutes(_legDurationController.text);
        if (minutes != null && _start != null) {
          _end = _start!.add(Duration(minutes: minutes));
          _endChanged = true;
        }
      }
      final departure = _start;
      final arrival = _end;
      if (departure != null &&
          arrival != null &&
          !arrival.isBefore(departure)) {
        _legDurationController.text = arrival
            .difference(departure)
            .inMinutes
            .toString();
      }
    }
    _syncShownDuration();
    _error = null;
  }

  Future<void> _fillFromConfirmation() async {
    final text = _confirmationController.text;
    if (text.trim().isEmpty || _parsingConfirmation) return;
    setState(() => _parsingConfirmation = true);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.parseConfirmation(
      text: text,
      type: _type,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      setState(() => _parsingConfirmation = false);
      await _endSession();
      return;
    }
    if (result.status == 403) {
      setState(() => _parsingConfirmation = false);
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (result.status == 402) {
      setState(() => _parsingConfirmation = false);
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to use AI.',
        token: userProvider.token,
      );
      return;
    }
    if (result.status != 200) {
      setState(() {
        _parsingConfirmation = false;
        _error = result.error ?? 'Could not read the confirmation';
      });
      return;
    }
    if (result.values.isEmpty) {
      setState(() {
        _parsingConfirmation = false;
        _error = 'No fields found in the text';
      });
      return;
    }
    setState(() {
      _parsingConfirmation = false;
      _applyConfirmation(result.values);
    });
  }

  Future<void> _endSession() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _submit() async {
    final fields = _fields();
    if (fields == null) return;
    if (!widget.isScreen) {
      Navigator.pop(context, fields);
      return;
    }
    final activityId = widget.activity?.id;
    if (activityId == null || activityId.isEmpty) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.updateActivity(
      activityId: activityId,
      name: fields.name,
      type: fields.type,
      startTime: fields.start,
      endTime: fields.end,
      timeZone: fields.timeZone,
      startTimeZone: fields.startTimeZone,
      endTimeZone: fields.endTimeZone,
      location: fields.location,
      googlePlaceId: fields.googlePlaceId,
      details: fields.details,
      bookingReference: fields.bookingReference,
      cost: fields.cost,
      costType: fields.costType,
      gate: fields.gate,
      baggageClaim: fields.baggageClaim,
      roomNumber: fields.roomNumber,
      origin: fields.origin,
      originCountry: fields.originCountry,
      destination: fields.destination,
      confirmation: fields.confirmation,
      durationMinutes: fields.durationMinutes,
      writeStartTime: fields.writeStart,
      writeEndTime: fields.writeEnd,
      writeDuration: fields.writeDuration,
      legs: fields.legs,
      planId: widget.planId ?? widget.activity?.planId ?? '',
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession();
      return;
    }
    if (status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: planProvider.writeMessage ?? 'Upgrade to Plus to edit this plan.',
        token: userProvider.token,
      );
      return;
    }
    if (status != 200) {
      setState(() => _error = 'Could not update activity');
      return;
    }
    Navigator.pop(context);
  }

  Future<void> _delete() async {
    final activity = widget.activity;
    final activityId = activity?.id;
    if (activity == null || activityId == null || activityId.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete activity'),
        content: Text('Delete ${activity.name}?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.deleteActivity(
      activityId: activityId,
      planId: widget.planId ?? activity.planId,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession();
      return;
    }
    if (status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: planProvider.writeMessage ?? 'Upgrade to Plus to edit this plan.',
        token: userProvider.token,
      );
      return;
    }
    if (status != 200) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not delete activity')),
      );
      return;
    }
    Navigator.pop(context);
  }

  void _applyLocationToPlaceSearch() {
    final next = placeSearchTextFromLocation(
      location: _locationController.text,
      search: _placeSearchController.text,
      seed: _placeSearchSeed,
    );
    if (next == null) return;
    _placeSearchSeed = next;
    _placeSearchController.text = next;
    _onPlaceSearchChanged(next);
  }

  void _onPlaceSearchChanged(String value) {
    _placeSearchTimer?.cancel();
    final query = value.trim();
    _placeSearchSeq += 1;
    setState(() {
      _placeSuggestions = const [];
      _placeSearchError = null;
    });
    if (query.isEmpty) return;
    final seq = _placeSearchSeq;
    _placeSearchTimer = Timer(placeSearchDebounce, () {
      _runPlaceSearch(query, seq);
    });
  }

  Future<void> _runPlaceSearch(String query, int seq) async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final result = await planProvider.searchPlaces(
      query: query,
      token: userProvider.token,
    );
    if (!mounted || seq != _placeSearchSeq) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status != 200) {
      setState(() {
        _placeSuggestions = const [];
        _placeSearchError = result.error ?? 'Could not search places';
      });
      return;
    }
    setState(() {
      _placeSuggestions = result.places;
      _placeSearchError = result.places.isEmpty ? 'No places found' : null;
    });
  }

  Future<void> _openSuggest() async {
    final planId = widget.planId?.trim() ?? '';
    if (planId.isEmpty) return;
    final picked = await showModalBottomSheet<Object>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _SuggestPlacesSheet(
        planId: planId,
        location: _locationController.text.trim(),
        destination: widget.planDestination.trim(),
        initialType: _type,
      ),
    );
    if (!mounted || picked == null) return;
    if (picked == 'unauthorized') {
      await _endSession();
      return;
    }
    if (picked is! PlaceSuggestion) return;
    final filled = fillActivityFromSuggestion(
      currentName: _nameController.text,
      currentLocation: _locationController.text,
      currentDetails: _detailsController.text,
      placeName: picked.name,
      address: picked.address,
      placeId: picked.placeId,
      summary: picked.summary,
    );
    setState(() {
      _nameController.text = filled.name;
      if (filled.setLocation) _locationController.text = filled.location;
      if (filled.googlePlaceId.isNotEmpty) {
        _googlePlaceIdController.text = filled.googlePlaceId;
      }
      _detailsController.text = filled.details;
    });
  }

  void _selectPlace(PlaceSuggestion place) {
    final selection = applyPlaceSelection(
      location: _locationController.text,
      placeId: place.placeId,
      name: place.name,
    );
    if (selection.googlePlaceId.isEmpty) return;
    _placeSearchTimer?.cancel();
    _placeSearchSeq += 1;
    setState(() {
      _googlePlaceIdController.text = selection.googlePlaceId;
      if (selection.location != null) {
        _locationController.text = selection.location!;
      }
      _placeSuggestions = const [];
      _placeSearchError = null;
      _placeSearchController.text = place.name;
    });
  }

  Widget _textField(
    TextEditingController controller,
    String label, {
    required String hint,
    required String tooltip,
    bool number = false,
    bool decimal = false,
    int minLines = 1,
    int maxLines = 1,
    ValueChanged<String>? onChanged,
    bool readOnly = false,
  }) {
    final severalLines = maxLines > 1;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: _textTooltip(
              tooltip,
              TextField(
                controller: controller,
                readOnly: readOnly,
                minLines: minLines,
                maxLines: maxLines,
                keyboardType: decimal
                    ? const TextInputType.numberWithOptions(decimal: true)
                    : number
                    ? TextInputType.number
                    : severalLines
                    ? TextInputType.multiline
                    : null,
                decoration: InputDecoration(labelText: label),
                onChanged: onChanged,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 4, top: 8),
            child: _FieldHint(hint),
          ),
        ],
      ),
    );
  }

  Widget _legTitle(String label) {
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
    );
  }

  Widget _removeLegButton(int index) {
    if (_extraLegs.isEmpty) return const SizedBox.shrink();
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        onPressed: () => _removeLeg(index),
        child: const Text('Remove'),
      ),
    );
  }

  Widget _legArrivalPicker({
    required String id,
    required bool durationSet,
    required DateTime? value,
    required String zone,
    required ValueChanged<String> onZoneChanged,
    required ValueChanged<DateTime> onChanged,
    VoidCallback? onClear,
  }) {
    return _UtcDateTimePicker(
      id: id,
      label: 'Arrival',
      hint: 'When this leg arrives. The clock uses the time zone under it.',
      tooltip: 'Arrival time of this leg',
      zoneTooltip: 'Time zone of the destination',
      value: value,
      zone: zone,
      onZoneChanged: onZoneChanged,
      onChanged: onChanged,
      onClear: durationSet ? null : onClear,
      enableClock: !durationSet,
    );
  }

  List<Widget> _flightLegFields() {
    return [
      _legTitle('Leg 1'),
      _textField(
        _originController,
        'Origin',
        tooltip: 'Origin of this flight leg',
        hint: 'Where this leg starts.',
        onChanged: (_) {
          _syncFlightLocation();
          setState(() => _error = null);
        },
      ),
      _UtcDateTimePicker(
        id: 'leg-1-departure',
        label: 'Departure',
        hint: 'When this leg leaves. The clock uses the time zone under it.',
        tooltip: 'Departure time of this leg',
        zoneTooltip: 'Time zone of the origin',
        value: _start,
        zone: _startZone,
        useStartPanel: true,
        planTimeZone: widget.planTimeZone,
        aboveInstant: widget.aboveInstant,
        fallbackStart: widget.fallbackStart,
        onZoneChanged: _onStartZone,
        onChanged: _setStart,
        onClear: widget.isScreen ? _clearStart : null,
      ),
      _textField(
        _destinationController,
        'Destination',
        tooltip: 'Destination of this flight leg',
        hint: 'Where this leg ends.',
        onChanged: (_) {
          _syncFlightLocation();
          setState(() => _error = null);
        },
      ),
      _textField(
        _legDurationController,
        'Duration (minutes)',
        tooltip: 'Length of this leg in minutes',
        hint: 'How many minutes this leg takes. The arrival follows the departure.',
        number: true,
        onChanged: _onLeg1DurationChanged,
      ),
      _legArrivalPicker(
        id: 'leg-1-arrival',
        durationSet: _wholeMinutes(_legDurationController.text) != null,
        value: _end,
        zone: _endZone,
        onZoneChanged: _onEndZone,
        onChanged: _setEnd,
        onClear: widget.isScreen ? _clearEnd : null,
      ),
      _removeLegButton(0),
      for (var index = 0; index < _extraLegs.length; index++) ...[
        _legTitle('Leg ${index + 2}'),
        _textField(
          _extraLegs[index].origin,
          'Origin',
          tooltip: 'Origin of this flight leg',
          hint: 'Where this leg starts.',
          onChanged: (_) => setState(() => _error = null),
        ),
        _UtcDateTimePicker(
          id: 'leg-${index + 2}-departure',
          label: 'Departure',
          hint: 'When this leg leaves. The clock uses the time zone under it.',
          tooltip: 'Departure time of this leg',
          zoneTooltip: 'Time zone of the origin',
          value: _extraLegs[index].departure,
          zone: _extraLegs[index].originZone,
          useStartPanel: true,
          planTimeZone: widget.planTimeZone,
          aboveInstant: widget.aboveInstant,
          fallbackStart: widget.fallbackStart,
          onZoneChanged: (zone) => _onExtraOriginZone(index, zone),
          onChanged: (instant) => _setExtraDeparture(index, instant),
          onClear: widget.isScreen ? () => _clearExtraDeparture(index) : null,
        ),
        _textField(
          _extraLegs[index].destination,
          'Destination',
          tooltip: 'Destination of this flight leg',
          hint: 'Where this leg ends.',
          onChanged: (_) {
            _syncFlightLocation();
            setState(() => _error = null);
          },
        ),
        _textField(
          _extraLegs[index].duration,
          'Duration (minutes)',
          tooltip: 'Length of this leg in minutes',
          hint: 'How many minutes this leg takes. The arrival follows the departure.',
          number: true,
          onChanged: (text) => _onExtraDurationChanged(index, text),
        ),
        _legArrivalPicker(
          id: 'leg-${index + 2}-arrival',
          durationSet: _wholeMinutes(_extraLegs[index].duration.text) != null,
          value: _extraLegs[index].arrival,
          zone: _extraLegs[index].destinationZone,
          onZoneChanged: (zone) => _onExtraDestinationZone(index, zone),
          onChanged: (instant) => _setExtraArrival(index, instant),
          onClear: widget.isScreen ? () => _clearExtraArrival(index) : null,
        ),
        _removeLegButton(index + 1),
      ],
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton(
          onPressed: _addLeg,
          child: const Text('Add leg'),
        ),
      ),
    ];
  }

  bool _inputApplies(_ActivityInput input) {
    switch (input) {
      case _ActivityInput.type:
      case _ActivityInput.name:
      case _ActivityInput.start:
      case _ActivityInput.end:
      case _ActivityInput.duration:
      case _ActivityInput.details:
      case _ActivityInput.cost:
        return true;
      case _ActivityInput.paste:
      case _ActivityInput.shuttleConfirmation:
        return _typeUsesConfirmation(_type);
      case _ActivityInput.legs:
      case _ActivityInput.gate:
      case _ActivityInput.baggage:
        return _typeUsesFlightFields(_type);
      case _ActivityInput.room:
        return _typeUsesRoom(_type);
      case _ActivityInput.shuttleOrigin:
      case _ActivityInput.shuttleDestination:
        return _typeUsesRoutePlaces(_type);
      case _ActivityInput.shuttleOriginCountry:
        return _typeUsesShuttleFields(_type);
      case _ActivityInput.location:
        return _typeUsesLocation(_type);
      case _ActivityInput.placeId:
        return _typeUsesPlaceId(_type);
      case _ActivityInput.bookingReference:
        return _typeUsesBookingReference(_type);
    }
  }

  Widget _inputWidget(_ActivityInput input) {
    switch (input) {
      case _ActivityInput.type:
        return Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: _fieldTooltip(
                  'Kind of activity (flight, hotel, dining, etc.)',
                  DropdownButtonFormField<String>(
                    initialValue: _type,
                    decoration: const InputDecoration(labelText: 'Activity Type'),
                    items: [
                      for (final type in activityTypeChoices(_type))
                        DropdownMenuItem(
                          value: type,
                          child: Text(activityTypeLabel(type)),
                        ),
                    ],
                    onChanged: (value) {
                      if (value == null) return;
                      setState(() => _type = value);
                    },
                  ),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(left: 4, top: 8),
                child: _FieldHint(
                  'The kind of activity. Fields for that kind are below the line.',
                ),
              ),
            ],
          ),
        );
      case _ActivityInput.name:
        return _textField(
          _nameController,
          'Name',
          tooltip: 'Short name of this activity',
          hint: 'The name shown on the itinerary.',
        );
      case _ActivityInput.paste:
        return Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: _textTooltip(
                      'Confirmation text used to fill other fields. This box is not saved.',
                      TextField(
                        controller: _confirmationController,
                        minLines: 3,
                        maxLines: 6,
                        decoration: const InputDecoration(
                          labelText: 'Confirmation',
                          alignLabelWithHint: true,
                        ),
                      ),
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(left: 4, top: 8),
                    child: _FieldHint(
                      'Paste a confirmation here. Fill from confirmation copies the fields it finds. This box is not saved.',
                    ),
                  ),
                ],
              ),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: _parsingConfirmation ? null : _fillFromConfirmation,
                  child: const Text('Fill from confirmation'),
                ),
              ),
            ],
          ),
        );
      case _ActivityInput.shuttleOrigin:
        return _textField(
          _shuttleOriginController,
          'Origin',
          tooltip: 'Starting place (airport, station, etc.)',
          hint: _usesShuttleFields
              ? 'Where the shuttle picks up.'
              : 'Where it leaves from.',
        );
      case _ActivityInput.shuttleOriginCountry:
        return _textField(
          _shuttleOriginCountryController,
          'Origin country',
          tooltip: 'Country where the shuttle picks up',
          hint: 'The country where the shuttle picks up.',
        );
      case _ActivityInput.shuttleDestination:
        return _textField(
          _shuttleDestinationController,
          'Destination',
          tooltip: 'Ending place',
          hint: _usesShuttleFields
              ? 'Where the shuttle drops off.'
              : 'Where it arrives.',
        );
      case _ActivityInput.start:
        return _UtcDateTimePicker(
          id: 'activity-start',
          label: 'Start',
          hint:
              'When this activity starts. Opens the day and the time together. The clock uses the time zone under it.',
          tooltip: 'When this activity starts',
          zoneTooltip: 'Time zone of the origin',
          value: _start,
          zone: _startZone,
          useStartPanel: true,
          planTimeZone: widget.planTimeZone,
          aboveInstant: widget.aboveInstant,
          fallbackStart: widget.fallbackStart,
          onZoneChanged: _onStartZone,
          onChanged: _setStart,
          onClear: widget.isScreen ? _clearStart : null,
        );
      case _ActivityInput.end:
        if (_usesFlightFields && _extraLegs.isNotEmpty) {
          final lastLeg = _extraLegs.length - 1;
          return _UtcDateTimePicker(
            id: 'activity-end',
            label: 'End',
            hint: 'When this activity ends. The clock uses the time zone under it.',
            tooltip: 'When this activity ends',
            zoneTooltip: 'Time zone of the destination',
            value: _spanEnd,
            zone: _extraLegs[lastLeg].destinationZone,
            onZoneChanged: (zone) => _onExtraDestinationZone(lastLeg, zone),
            onChanged: (instant) => _setExtraArrival(lastLeg, instant),
            onClear: widget.isScreen ? () => _clearExtraArrival(lastLeg) : null,
          );
        }
        return _UtcDateTimePicker(
          id: 'activity-end',
          label: 'End',
          hint: 'When this activity ends. The clock uses the time zone under it.',
          tooltip: 'When this activity or leg ends',
          zoneTooltip: 'Time zone of the destination',
          value: _end,
          zone: _endZone,
          onZoneChanged: _onEndZone,
          onChanged: _setEnd,
          onClear: widget.isScreen ? _clearEnd : null,
        );
      case _ActivityInput.duration:
        return _textField(
          _durationController,
          'Duration (minutes)',
          tooltip: 'Length in minutes',
          hint: _usesFlightFields
              ? 'Length in minutes. The end time still follows the last leg.'
              : 'How long this activity lasts, in minutes. A number here sets the end from the start.',
          number: true,
          onChanged: _onDurationChanged,
        );
      case _ActivityInput.legs:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _flightLegFields(),
        );
      case _ActivityInput.location:
        return _textField(
          _locationController,
          'Location',
          tooltip: 'Place name or address',
          hint: 'The place name or address.',
          onChanged: (_) => _applyLocationToPlaceSearch(),
        );
      case _ActivityInput.placeId:
        return Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if ((widget.planId ?? '').trim().isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: _openSuggest,
                    child: const Text('Suggest'),
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: _textTooltip(
                      'Search for a place by name',
                      TextField(
                        controller: _placeSearchController,
                        decoration: const InputDecoration(
                          labelText: 'Search places',
                        ),
                        onChanged: _onPlaceSearchChanged,
                      ),
                    ),
                  ),
                  const _FieldHint(
                    'Starts with the location. Choosing a match fills the location and the Place ID.',
                  ),
                ],
              ),
              if (_placeSearchError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    _placeSearchError!,
                    style: const TextStyle(color: Colors.red),
                  ),
                ),
              for (final place in _placeSuggestions)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => _selectPlace(place),
                    child: Text(
                      place.address.isEmpty
                          ? place.name
                          : '${place.name}, ${place.address}',
                      textAlign: TextAlign.start,
                    ),
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: _textTooltip(
                      'Optional Google Place ID for maps and directions',
                      TextField(
                        controller: _googlePlaceIdController,
                        decoration: const InputDecoration(
                          labelText: 'Google Place ID',
                        ),
                      ),
                    ),
                  ),
                  const _FieldHint(
                    'The Google place id used for directions.',
                  ),
                ],
              ),
            ],
          ),
        );
      case _ActivityInput.details:
        return _textField(
          _detailsController,
          'Details',
          tooltip: 'Extra notes',
          hint: 'Notes about this activity.',
          minLines: 3,
          maxLines: 6,
        );
      case _ActivityInput.bookingReference:
        return _textField(
          _bookingReferenceController,
          'Booking reference',
          tooltip: 'Confirmation or booking code',
          hint: 'The reservation code. This is not the confirmation.',
        );
      case _ActivityInput.cost:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _textField(
              _costController,
              'Cost',
              tooltip: 'Cost amount',
              hint: 'What this activity costs.',
              decimal: true,
            ),
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: _fieldTooltip(
                      'Estimated or actual',
                      SegmentedButton<String>(
                        showSelectedIcon: false,
                        segments: const [
                          ButtonSegment(value: 'estimated', label: Text('Estimated')),
                          ButtonSegment(value: 'actual', label: Text('Actual')),
                        ],
                        selected: {_costType},
                        onSelectionChanged: (next) {
                          setState(() => _costType = next.first);
                        },
                      ),
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: _FieldHint(
                      'Estimated is a planned amount. Actual is the amount paid.',
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      case _ActivityInput.gate:
        return _textField(
          _gateController,
          'Gate',
          tooltip: 'Departure gate',
          hint: 'The departure gate.',
        );
      case _ActivityInput.baggage:
        return _textField(
          _baggageController,
          'Baggage claim',
          tooltip: 'Where checked bags are collected',
          hint: 'Where checked bags are collected.',
        );
      case _ActivityInput.room:
        return _textField(
          _roomController,
          'Room number',
          tooltip: 'Room for this stay or event',
          hint: 'The room for this stay or event.',
        );
      case _ActivityInput.shuttleConfirmation:
        return _textField(
          _shuttleConfirmationController,
          'Confirmation',
          tooltip: 'Confirmation code, separate from the booking reference',
          hint: _usesShuttleFields
              ? 'The shuttle confirmation. This is separate from the booking reference.'
              : 'The confirmation. This is separate from the booking reference.',
        );
    }
  }

  Widget _fieldsColumn() {
    const above = [
      _ActivityInput.start,
      _ActivityInput.end,
      _ActivityInput.duration,
      _ActivityInput.details,
      _ActivityInput.cost,
    ];
    const below = [
      _ActivityInput.paste,
      _ActivityInput.legs,
      _ActivityInput.gate,
      _ActivityInput.baggage,
      _ActivityInput.shuttleOrigin,
      _ActivityInput.shuttleOriginCountry,
      _ActivityInput.shuttleDestination,
      _ActivityInput.location,
      _ActivityInput.placeId,
      _ActivityInput.bookingReference,
      _ActivityInput.shuttleConfirmation,
      _ActivityInput.room,
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _inputWidget(_ActivityInput.name),
        _inputWidget(_ActivityInput.type),
        for (final input in above)
          if (_inputApplies(input)) _inputWidget(input),
        const Padding(
          padding: EdgeInsets.only(top: 20, bottom: 4),
          child: Divider(),
        ),
        for (final input in below)
          if (_inputApplies(input)) _inputWidget(input),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: Colors.red)),
        ],
        if (_attachmentActivityId != null) ...[
          const SizedBox(height: 20),
          ActivityAttachmentsSection(
            activityId: _attachmentActivityId!,
            planId: _attachmentPlanId,
          ),
        ] else if (widget.activity == null) ...[
          const Padding(
            padding: EdgeInsets.only(top: 16),
            child: Text('Save the activity to attach a file.'),
          ),
        ],
      ],
    );
  }

  String? get _attachmentActivityId {
    final id = widget.activity?.id;
    if (id == null || id.trim().isEmpty) return null;
    return id;
  }

  String get _attachmentPlanId {
    final fromWidget = widget.planId?.trim() ?? '';
    if (fromWidget.isNotEmpty) return fromWidget;
    return widget.activity?.planId ?? '';
  }

  @override
  Widget build(BuildContext context) {
    final Widget form;
    if (widget.isScreen) {
      form = Scaffold(
        appBar: AppBar(
          title: Text(widget.title),
          actions: [
            IconButton(
              tooltip: 'Save',
              icon: const Icon(Icons.save),
              onPressed: _submit,
            ),
            IconButton(
              tooltip: 'Delete activity',
              icon: const Icon(Icons.delete),
              onPressed: _delete,
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _fieldsColumn(),
          ],
        ),
      );
    } else {
      form = AlertDialog(
        title: Text(widget.title),
        content: SingleChildScrollView(child: _fieldsColumn()),
        actions: [
          TextButton(
            onPressed: () => Navigator.maybePop(context),
            child: const Text('Cancel'),
          ),
          TextButton(onPressed: _submit, child: Text(widget.actionLabel)),
        ],
      );
    }
    // canPop stays false so a keystroke does not have to rebuild.
    // Back checks the opened snapshot. Save and delete call Navigator.pop.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _onLeaveAttempt();
      },
      child: form,
    );
  }
}

class _PrintPlanOptions {
  final bool landscape;
  final bool includeMaps;

  const _PrintPlanOptions({
    required this.landscape,
    required this.includeMaps,
  });
}

class _PrintOrientationDialog extends StatefulWidget {
  const _PrintOrientationDialog();

  @override
  State<_PrintOrientationDialog> createState() =>
      _PrintOrientationDialogState();
}

class _PrintOrientationDialogState extends State<_PrintOrientationDialog> {
  bool _landscape = true;
  bool _includeMaps = false;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Print'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SegmentedButton<bool>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: false, label: Text('Portrait')),
              ButtonSegment(value: true, label: Text('Landscape')),
            ],
            selected: {_landscape},
            onSelectionChanged: (next) {
              setState(() => _landscape = next.first);
            },
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _includeMaps,
            onChanged: (next) {
              setState(() => _includeMaps = next ?? false);
            },
            title: const Text('Include maps'),
            subtitle: const Text(
              'A Google Map around each destination that has a Place ID',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(
            context,
            _PrintPlanOptions(
              landscape: _landscape,
              includeMaps: _includeMaps,
            ),
          ),
          child: const Text('Print'),
        ),
      ],
    );
  }
}

class _PlanEditScreen extends StatefulWidget {
  final Plan plan;
  final bool canDelete;

  const _PlanEditScreen({required this.plan, required this.canDelete});

  @override
  State<_PlanEditScreen> createState() => _PlanEditScreenState();
}

class _PlanEditScreenState extends State<_PlanEditScreen> {
  late final TextEditingController _nameController;
  late final TextEditingController _destinationController;
  late final TextEditingController _budgetController;
  late final Listenable _planText;
  late final String _openedName;
  late final String _openedDestination;
  late final String _openedBudget;
  late final String _openedTimeZone;
  late final bool _openedAutoStart;
  late final bool _openedAutoEnd;
  late final Set<String> _openedHidden;
  late bool _autoStart;
  late bool _autoEnd;
  late final Set<String> _hiddenFields;
  late String _timeZone;
  DateTime? _start;
  DateTime? _end;
  DateTime? _openedStart;
  DateTime? _openedEnd;
  String? _error;

  @override
  void initState() {
    super.initState();
    final plan = widget.plan;
    _nameController = TextEditingController(text: plan.name);
    _destinationController = TextEditingController(text: plan.destination);
    _budgetController = TextEditingController(text: _costBoxText(plan.budget));
    _planText = Listenable.merge([
      _nameController,
      _destinationController,
      _budgetController,
    ]);
    _start = plan.startDate;
    _end = plan.endDate;
    _openedStart = plan.startDate;
    _openedEnd = plan.endDate;
    final storedZone = plan.timeZone.trim();
    _timeZone = storedZone.isEmpty ? 'UTC' : storedZone;
    _autoStart = plan.autoCalculateStartDate;
    _autoEnd = plan.autoCalculateEndDate;
    _hiddenFields = {
      for (final name in plan.hiddenFields)
        if (guestHiddenFieldNames.contains(name)) name,
    };
    _openedName = plan.name.trim();
    _openedDestination = plan.destination.trim();
    _openedBudget = _budgetController.text.trim();
    _openedTimeZone = _timeZone;
    _openedAutoStart = _autoStart;
    _openedAutoEnd = _autoEnd;
    _openedHidden = Set<String>.from(_hiddenFields);
  }

  @override
  void dispose() {
    _nameController.dispose();
    _destinationController.dispose();
    _budgetController.dispose();
    super.dispose();
  }

  bool _sameInstant(DateTime? left, DateTime? right) {
    if (left == null || right == null) return left == null && right == null;
    return left.toUtc().microsecondsSinceEpoch ==
        right.toUtc().microsecondsSinceEpoch;
  }

  bool _sameHidden(Set<String> left, Set<String> right) {
    if (left.length != right.length) return false;
    for (final name in left) {
      if (!right.contains(name)) return false;
    }
    return true;
  }

  bool _planChanged() {
    return _nameController.text.trim() != _openedName ||
        _destinationController.text.trim() != _openedDestination ||
        _budgetController.text.trim() != _openedBudget ||
        _timeZone != _openedTimeZone ||
        !_sameInstant(_start, _openedStart) ||
        !_sameInstant(_end, _openedEnd) ||
        _autoStart != _openedAutoStart ||
        _autoEnd != _openedAutoEnd ||
        !_sameHidden(_hiddenFields, _openedHidden);
  }

  DateTime get _planZoneAnchor => _start ?? _end ?? DateTime.now().toUtc();

  Widget _planZoneField() {
    final choices = planZoneOptions(_timeZone);
    final anchor = _planZoneAnchor;
    return DropdownButtonFormField<String>(
      key: ValueKey('plan-zone|$_timeZone'),
      initialValue: _timeZone,
      isExpanded: true,
      decoration: const InputDecoration(labelText: 'Time zone'),
      selectedItemBuilder: (context) => [
        for (final choice in choices)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              zoneDaylightLabel(anchor, choice),
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
      items: [
        for (final choice in choices)
          DropdownMenuItem(
            value: choice,
            child: Text(planZoneMenuLabel(choice)),
          ),
      ],
      onChanged: (next) {
        if (next == null || next == _timeZone) return;
        setState(() => _timeZone = next);
      },
    );
  }

  Future<void> _endSession() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    final destination = _destinationController.text.trim();
    final timeZone = _timeZone.trim();
    final budgetText = _budgetController.text.trim();
    final double? budget;
    if (budgetText.isEmpty) {
      budget = null;
    } else {
      final parsed = double.tryParse(budgetText);
      if (parsed == null || parsed.isNaN || parsed.isInfinite) {
        setState(() => _error = 'Budget must be a number');
        return;
      }
      budget = parsed;
    }
    final start = _start;
    final end = _end;
    if (name.isEmpty || timeZone.isEmpty) {
      setState(() => _error = 'Enter a name and a time zone');
      return;
    }
    if (widget.plan.type == 'trip' && destination.isEmpty) {
      setState(() => _error = 'Enter a destination');
      return;
    }
    if (start != null && end != null && end.isBefore(start)) {
      setState(() => _error = 'End date must not be before the start date');
      return;
    }
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.updatePlan(
      planId: widget.plan.id,
      name: name,
      destination: destination,
      budget: budget,
      startDate: start,
      endDate: end,
      timeZone: timeZone,
      autoCalculateStartDate: _autoStart,
      autoCalculateEndDate: _autoEnd,
      hiddenFields: [
        for (final name in guestHiddenFieldNames)
          if (_hiddenFields.contains(name)) name,
      ],
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to edit this plan.',
        token: userProvider.token,
      );
      return;
    }
    if (result.status != 200 || result.plan == null) {
      setState(() => _error = result.error ?? 'Could not update plan');
      return;
    }
    _budgetController.text = _costBoxText(result.plan!.budget);
    Navigator.pop(context);
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete plan'),
        content: Text('Delete ${widget.plan.name}?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.deletePlan(
      planId: widget.plan.id,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status == 403) {
      messenger.showSnackBar(const SnackBar(content: Text('Not allowed')));
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.message ?? 'Upgrade to Plus to delete a plan.',
        token: userProvider.token,
      );
      return;
    }
    if (result.status == 409) {
      final shared = result.sharedWith;
      final detail = shared.isEmpty
          ? 'This plan is still shared with someone else.'
          : 'This plan is still shared with:\n${shared.join('\n')}';
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Plan is still shared'),
          content: Text(detail),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('OK'),
            ),
          ],
        ),
      );
      return;
    }
    if (result.status != 200) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not delete plan')),
      );
      return;
    }
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit plan'),
        actions: [
          ListenableBuilder(
            listenable: _planText,
            builder: (context, _) {
              if (!_planChanged()) return const SizedBox.shrink();
              return TextButton(
                onPressed: _submit,
                style: TextButton.styleFrom(
                  foregroundColor: Theme.of(context).colorScheme.onPrimary,
                ),
                child: const Text('Save'),
              );
            },
          ),
          if (widget.canDelete)
            IconButton(
              tooltip: 'Delete plan',
              icon: const Icon(Icons.delete),
              onPressed: _delete,
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _nameController,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _destinationController,
            decoration: const InputDecoration(labelText: 'Destination'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _budgetController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Budget'),
          ),
          const SizedBox(height: 12),
          _planZoneField(),
          _UtcDateTimePicker(
            id: 'plan-start',
            label: 'Start',
            value: _start,
            zone: _timeZone,
            showDaylightLabel: true,
            onChanged: (value) => setState(() => _start = value.toUtc()),
            onClear: () => setState(() => _start = null),
          ),
          _UtcDateTimePicker(
            id: 'plan-end',
            label: 'End',
            value: _end,
            zone: _timeZone,
            showDaylightLabel: true,
            onChanged: (value) => setState(() => _end = value.toUtc()),
            onClear: () => setState(() => _end = null),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Auto-calculate start date'),
            value: _autoStart,
            onChanged: (value) => setState(() => _autoStart = value),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Auto-calculate end date'),
            value: _autoEnd,
            onChanged: (value) => setState(() => _autoEnd = value),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Text(
              'Hidden from guests',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
          for (final name in guestHiddenFieldNames)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(guestHiddenFieldLabels[name] ?? name),
              value: _hiddenFields.contains(name),
              onChanged: (checked) {
                setState(() {
                  if (checked == true) {
                    _hiddenFields.add(name);
                  } else {
                    _hiddenFields.remove(name);
                  }
                });
              },
            ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
        ],
      ),
    );
  }
}

class _LinkActivitiesDialog extends StatefulWidget {
  final List<Activity> activities;
  final Set<String> checkedIds;
  final String actionLabel;

  const _LinkActivitiesDialog({
    required this.activities,
    required this.checkedIds,
    required this.actionLabel,
  });

  @override
  State<_LinkActivitiesDialog> createState() => _LinkActivitiesDialogState();
}

class _LinkActivitiesDialogState extends State<_LinkActivitiesDialog> {
  late final Set<String> _checked;

  @override
  void initState() {
    super.initState();
    _checked = {
      for (final activity in widget.activities)
        if (widget.checkedIds.contains(activity.id)) activity.id!,
    };
  }

  bool get _allChecked {
    if (widget.activities.isEmpty) return false;
    for (final activity in widget.activities) {
      final id = activity.id;
      if (id == null || id.isEmpty || !_checked.contains(id)) return false;
    }
    return true;
  }

  void _setAll(bool checked) {
    setState(() {
      _checked.clear();
      if (!checked) return;
      for (final activity in widget.activities) {
        final id = activity.id;
        if (id != null && id.isNotEmpty) _checked.add(id);
      }
    });
  }

  void _submit() {
    Navigator.pop(context, [
      for (final activity in widget.activities)
        if (_checked.contains(activity.id)) activity.id!,
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Link my plan'),
      content: SizedBox(
        width: double.maxFinite,
        height: 360,
        child: widget.activities.isEmpty
            ? const Text('No activities yet')
            : Column(
                children: [
                  CheckboxListTile(
                    value: _allChecked,
                    controlAffinity: ListTileControlAffinity.leading,
                    title: const Text('Select all'),
                    onChanged: (checked) => _setAll(checked == true),
                  ),
                  Expanded(
                    child: ListView(
                      children: [
                        for (final activity in widget.activities)
                          CheckboxListTile(
                            value: _checked.contains(activity.id),
                            controlAffinity: ListTileControlAffinity.leading,
                            title: Text(
                              activity.name.trim().isEmpty
                                  ? 'Unnamed activity'
                                  : activity.name.trim(),
                            ),
                            onChanged: (checked) {
                              final id = activity.id;
                              if (id == null || id.isEmpty) return;
                              setState(() {
                                if (checked == true) {
                                  _checked.add(id);
                                } else {
                                  _checked.remove(id);
                                }
                              });
                            },
                          ),
                      ],
                    ),
                  ),
                ],
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: _submit,
          child: Text(widget.actionLabel),
        ),
      ],
    );
  }
}
