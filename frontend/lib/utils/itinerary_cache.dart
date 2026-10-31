import 'dart:convert';

import '../models/activity.dart';
import '../models/plan.dart';

const itineraryCacheFolder = 'itineraries';

/// Android and iOS keep a saved itinerary. Web and desktop always use the network.
bool itineraryCacheEnabled({required bool web, required String platform}) {
  if (web) return false;
  return platform == 'android' || platform == 'iOS';
}

/// One activity row stored with the plan snapshot.
class CachedItineraryActivity {
  final String title;
  final String type;
  final String? start;
  final String? end;
  final String location;
  final String googlePlaceId;
  final String details;
  final double? cost;
  final String bookingReference;

  const CachedItineraryActivity({
    required this.title,
    required this.type,
    required this.start,
    required this.end,
    required this.location,
    required this.googlePlaceId,
    required this.details,
    required this.cost,
    required this.bookingReference,
  });

  factory CachedItineraryActivity.fromActivity(Activity activity) {
    final storedType = activity.typeLabel.trim();
    return CachedItineraryActivity(
      title: activity.name,
      type: storedType.isEmpty ? activity.type.name : storedType,
      start: _iso(activity.startTime),
      end: _iso(activity.endTime),
      location: activity.location?.trim() ?? '',
      googlePlaceId: activity.googlePlaceId.trim(),
      details: activity.details?.trim() ?? '',
      cost: activity.cost,
      bookingReference: activity.bookingReference?.trim() ?? '',
    );
  }

  Activity toActivity(String planId) {
    return Activity.fromJson({
      'planId': planId,
      'name': title,
      'type': type,
      if (start != null) 'startTime': start,
      if (end != null) 'endTime': end,
      'location': location,
      'googlePlaceId': googlePlaceId,
      'details': details,
      if (cost != null) 'cost': cost,
      'bookingReference': bookingReference,
    });
  }

  Map<String, dynamic> toJson() {
    return {
      'title': title,
      'type': type,
      'start': start,
      'end': end,
      'location': location,
      'googlePlaceId': googlePlaceId,
      'details': details,
      'cost': cost,
      'bookingReference': bookingReference,
    };
  }

  static CachedItineraryActivity? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final start = _keptIso(raw['start']);
    final end = _keptIso(raw['end']);
    if (raw['start'] != null && start == null && _text(raw['start']).isNotEmpty) {
      return null;
    }
    if (raw['end'] != null && end == null && _text(raw['end']).isNotEmpty) {
      return null;
    }
    return CachedItineraryActivity(
      title: _text(raw['title']),
      type: _text(raw['type']),
      start: start,
      end: end,
      location: _text(raw['location']),
      googlePlaceId: _text(raw['googlePlaceId']),
      details: _text(raw['details']),
      cost: raw['cost'] is num ? (raw['cost'] as num).toDouble() : null,
      bookingReference: _text(raw['bookingReference']),
    );
  }
}

/// Saved plan header and activities for one plan.
class ItinerarySnapshot {
  final String planId;
  final String name;
  final String timeZone;
  final List<CachedItineraryActivity> activities;

  const ItinerarySnapshot({
    required this.planId,
    required this.name,
    required this.timeZone,
    required this.activities,
  });

  List<Activity> toActivities() {
    return [
      for (final activity in activities) activity.toActivity(planId),
    ];
  }

  String encode() => jsonEncode(toJson());

  Map<String, dynamic> toJson() {
    return {
      'planId': planId,
      'name': name,
      'timeZone': timeZone,
      'activities': [for (final activity in activities) activity.toJson()],
    };
  }

  static ItinerarySnapshot? decode(String raw) {
    final dynamic data;
    try {
      data = jsonDecode(raw);
    } catch (_) {
      return null;
    }
    if (data is! Map) return null;
    final planId = _text(data['planId']);
    if (planId.isEmpty) return null;
    final rows = data['activities'];
    final activities = <CachedItineraryActivity>[];
    if (rows is List) {
      for (final row in rows) {
        final activity = CachedItineraryActivity.fromJson(row);
        if (activity != null) activities.add(activity);
      }
    }
    return ItinerarySnapshot(
      planId: planId,
      name: _text(data['name']),
      timeZone: _text(data['timeZone']),
      activities: activities,
    );
  }
}

ItinerarySnapshot captureItinerary({
  required Plan plan,
  required List<Activity> activities,
}) {
  return ItinerarySnapshot(
    planId: plan.id.trim(),
    name: plan.name,
    timeZone: plan.timeZone.trim(),
    activities: [
      for (final activity in activities)
        CachedItineraryActivity.fromActivity(activity),
    ],
  );
}

/// File under the app documents directory, or null when the root or plan id is empty.
String? itineraryCacheFilePath({
  required String documentsDir,
  required String planId,
  String separator = '/',
}) {
  final root = documentsDir.trim();
  final id = _safePlanId(planId);
  if (root.isEmpty || id.isEmpty || separator.isEmpty) return null;
  final relative = '$itineraryCacheFolder/$id.json';
  if (relative.contains('..') || relative.contains('\\')) return null;
  final prefix = root.endsWith(separator) ? root : '$root$separator';
  return '$prefix${relative.replaceAll('/', separator)}';
}

String? _iso(DateTime? value) => value?.toUtc().toIso8601String();

String? _keptIso(Object? value) {
  final text = _text(value);
  if (text.isEmpty) return null;
  return DateTime.tryParse(text)?.toUtc().toIso8601String();
}

String _text(Object? value) => value == null ? '' : value.toString().trim();

String _safePlanId(String planId) {
  return planId.trim().replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');
}
