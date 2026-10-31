// For ChangeNotifier
import '../api/api_client.dart'
    as http; // Retries once after a silent token refresh
import 'dart:convert'; // For JSON
import 'dart:typed_data';
// Added for Provider.of (token from UserProvider)
import '../config/constants.dart'; // Add this line for backendBaseUrl
// Add this line for UserProvider (token)
import 'package:flutter/material.dart'; // Added: Required for Icon
import '../models/membership_tier.dart';
import '../models/plan.dart'; // Your Plan model
import '../models/plan_template.dart';
import '../models/plan_member.dart';
import '../models/activity.dart';
import '../models/activity_warning.dart';
import '../models/activity_reaction.dart';
import '../models/activity_attachment.dart';
import '../models/activity_type.dart';
import '../models/user.dart'; // Your User model
import '../utils/activity_attachment.dart';
import '../utils/logger.dart';

Map<String, dynamic> _itineraryActivityJson(Map source) {
  final map = Map<String, dynamic>.from(source);
  final duration = map['duration'];
  if (duration is num) {
    map['duration'] = duration.round();
  } else {
    map['duration'] = null;
  }
  final subActivities = map['subEvents'];
  map['subEvents'] = subActivities is List
      ? subActivities
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item))
            .toList()
      : <Map<String, dynamic>>[];
  final links = map['urlLinks'];
  map['urlLinks'] = links is List
      ? links
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item))
            .toList()
      : <Map<String, dynamic>>[];
  final missing = map['missingFields'];
  map['missingFields'] = missing is List
      ? missing.map((item) => item.toString()).toList()
      : <String>[];
  if (map['extras'] is! Map) map['extras'] = <String, dynamic>{};
  return map;
}

String _activityInstant(DateTime utc) {
  return utc.toUtc().toIso8601String();
}

Map<String, dynamic> _flightLegBody(FlightLeg leg) {
  final departure = leg.departure;
  final arrival = leg.arrival;
  return {
    'origin': leg.origin,
    'originTimeZone': leg.originTimeZone,
    'departure': departure == null ? null : _activityInstant(departure),
    'destination': leg.destination,
    'destinationTimeZone': leg.destinationTimeZone,
    'arrival': arrival == null ? null : _activityInstant(arrival),
    'durationMinutes': leg.durationMinutes,
  };
}

/// Shared activity fields plus only the fields the selected type keeps.
Map<String, dynamic> _activityWriteBody({
  required String name,
  required String type,
  DateTime? startTime,
  DateTime? endTime,
  required String location,
  required String googlePlaceId,
  required String details,
  required String bookingReference,
  double? cost,
  required String costType,
  required String timeZone,
  required String startTimeZone,
  required String endTimeZone,
  String? gate,
  String? baggageClaim,
  String? roomNumber,
  String? origin,
  String? originCountry,
  String? destination,
  String? confirmation,
  String? planId,
  int? durationMinutes,
  bool? writeStartTime,
  bool? writeEndTime,
  bool? writeDuration,
  String? insertAfter,
  String? insertBefore,
  List<FlightLeg>? legs,
}) {
  final body = <String, dynamic>{
    'name': name,
    'type': type,
    'location': location,
    'googlePlaceId': googlePlaceId.trim(),
    'details': details,
    'bookingReference': bookingReference.trim(),
    'cost': cost,
    'costType': costType,
    'timeZone': timeZone,
    'startTimeZone': startTimeZone,
    'endTimeZone': endTimeZone,
  };
  final sendStart = writeStartTime ?? startTime != null;
  final sendEnd = writeEndTime ?? endTime != null;
  final sendDuration = writeDuration ?? durationMinutes != null;
  if (sendStart) {
    body['startTime'] = startTime == null ? null : _activityInstant(startTime);
  }
  if (sendEnd) {
    body['endTime'] = endTime == null ? null : _activityInstant(endTime);
  }
  if (sendDuration) body['durationMinutes'] = durationMinutes;
  if (planId != null) body['planId'] = planId;
  if (type == 'flight') {
    body['gate'] = gate ?? '';
    body['baggageClaim'] = baggageClaim ?? '';
    if (confirmation != null) body['confirmation'] = confirmation.trim();
    if (legs != null) {
      body['legs'] = [for (final leg in legs) _flightLegBody(leg)];
    }
  }
  if (type == 'hotel' || type == 'ceremony' || type == 'reception') {
    body['roomNumber'] = roomNumber ?? '';
  }
  if (type == 'hotel' && confirmation != null) {
    body['confirmation'] = confirmation.trim();
  }
  if (type == 'shuttle' || type == 'train' || type == 'cruise') {
    if (origin != null) body['origin'] = origin.trim();
    if (type == 'shuttle' && originCountry != null) {
      body['originCountry'] = originCountry.trim();
    }
    if (destination != null) body['destination'] = destination.trim();
    if (confirmation != null) body['confirmation'] = confirmation.trim();
  }
  if (insertAfter != null && insertAfter.isNotEmpty) {
    body['insertAfter'] = insertAfter;
  }
  if (insertBefore != null && insertBefore.isNotEmpty) {
    body['insertBefore'] = insertBefore;
  }
  return body;
}

int _byStartTime(Activity a, Activity b) {
  final aStart = a.startTime;
  final bStart = b.startTime;
  if (aStart == null && bStart == null) return 0;
  if (aStart == null) return 1;
  if (bStart == null) return -1;
  return aStart.compareTo(bStart);
}

List<Activity> _sortedByStartTime(List<Activity> activities) {
  final indexed = <({Activity activity, int index})>[
    for (var index = 0; index < activities.length; index++)
      (activity: activities[index], index: index),
  ];
  indexed.sort((a, b) {
    final byStart = _byStartTime(a.activity, b.activity);
    if (byStart != 0) return byStart;
    return a.index.compareTo(b.index);
  });
  return [for (final item in indexed) item.activity];
}

String? _roleFromUsersBody(String body, String userId) {
  final dynamic data = json.decode(body);
  final List<dynamic> users;
  if (data is Map && data['users'] is List) {
    users = data['users'] as List;
  } else if (data is List) {
    users = data;
  } else {
    return null;
  }
  for (final item in users) {
    if (item is! Map) continue;
    final idValue = item['userId'];
    final id = idValue is Map
        ? (idValue['_id'] ?? idValue['id'])?.toString() ?? ''
        : idValue?.toString() ?? '';
    if (id != userId) continue;
    final role = item['role'];
    if (role == null) return null;
    return role.toString();
  }
  return null;
}

class PlanDeleteResult {
  final int? status;
  final List<String> sharedWith;
  final String? message;

  const PlanDeleteResult({
    this.status,
    this.sharedWith = const [],
    this.message,
  });
}

class PlanUpdateResult {
  final int? status;
  final Plan? plan;
  final String? error;

  const PlanUpdateResult({this.status, this.plan, this.error});
}

class PlanLinkResult {
  final int? status;
  final Plan? plan;
  final String? error;

  const PlanLinkResult({this.status, this.plan, this.error});
}

class PlanRead {
  final int? status;
  final Plan? plan;
  final String? error;

  const PlanRead({this.status, this.plan, this.error});
}

class PlanMembersRead {
  final int? status;
  final List<PlanMember> members;
  final String? error;

  const PlanMembersRead({
    this.status,
    this.members = const [],
    this.error,
  });
}

class PlanItineraryRead {
  final int? status;
  final List<Activity> activities;
  final String? error;

  const PlanItineraryRead({
    this.status,
    this.activities = const [],
    this.error,
  });
}

class PlanInviteResult {
  final int? status;
  final String? error;

  const PlanInviteResult({this.status, this.error});
}

class PlanMemberRemoveResult {
  final int? status;
  final String? error;

  const PlanMemberRemoveResult({this.status, this.error});
}

class PlanReassignResult {
  final int? status;
  final String? error;
  final String? ownerId;

  const PlanReassignResult({this.status, this.error, this.ownerId});
}

Plan _planWithSourceId(Plan plan, String sourcePlanId) {
  if (plan.sourcePlanId == sourcePlanId) return plan;
  return Plan(
    id: plan.id,
    type: plan.type,
    name: plan.name,
    destination: plan.destination,
    startDate: plan.startDate,
    endDate: plan.endDate,
    autoCalculateStartDate: plan.autoCalculateStartDate,
    autoCalculateEndDate: plan.autoCalculateEndDate,
    location: plan.location,
    budget: plan.budget,
    planningState: plan.planningState,
    timeZone: plan.timeZone,
    participants: plan.participants,
    ownerId: plan.ownerId,
    activityIds: plan.activityIds,
    createdAt: plan.createdAt,
    earliestStart: plan.earliestStart,
    latestEnd: plan.latestEnd,
    sourcePlanId: sourcePlanId,
    linkedActivityIds: plan.linkedActivityIds,
    linkStart: plan.linkStart,
    linkEnd: plan.linkEnd,
    hiddenFields: plan.hiddenFields,
  );
}

Plan _planWithOwner(Plan plan, String ownerId) {
  return Plan(
    id: plan.id,
    type: plan.type,
    name: plan.name,
    destination: plan.destination,
    startDate: plan.startDate,
    endDate: plan.endDate,
    autoCalculateStartDate: plan.autoCalculateStartDate,
    autoCalculateEndDate: plan.autoCalculateEndDate,
    location: plan.location,
    budget: plan.budget,
    planningState: plan.planningState,
    timeZone: plan.timeZone,
    participants: plan.participants,
    ownerId: ownerId,
    activityIds: plan.activityIds,
    createdAt: plan.createdAt,
    earliestStart: plan.earliestStart,
    latestEnd: plan.latestEnd,
    sourcePlanId: plan.sourcePlanId,
    linkedActivityIds: plan.linkedActivityIds,
    linkStart: plan.linkStart,
    linkEnd: plan.linkEnd,
    hiddenFields: plan.hiddenFields,
  );
}

/// PUT /api/plans/:planId does not return the activity date span that GET adds.
/// Keep the previous span when the saved plan has none, so the list date line stays.
/// [sourcePlanId] keeps a saved link when the new payload leaves that field blank.
Plan _planKeepingActivitySpan(
  Plan updated,
  Plan previous, {
  String? sourcePlanId,
}) {
  final earliestStart = updated.earliestStart ?? previous.earliestStart;
  final latestEnd = updated.latestEnd ?? previous.latestEnd;
  final source = sourcePlanId ?? updated.sourcePlanId;
  if (earliestStart == updated.earliestStart &&
      latestEnd == updated.latestEnd &&
      source == updated.sourcePlanId) {
    return updated;
  }
  return Plan(
    id: updated.id,
    type: updated.type,
    name: updated.name,
    destination: updated.destination,
    startDate: updated.startDate,
    endDate: updated.endDate,
    autoCalculateStartDate: updated.autoCalculateStartDate,
    autoCalculateEndDate: updated.autoCalculateEndDate,
    location: updated.location,
    budget: updated.budget,
    planningState: updated.planningState,
    timeZone: updated.timeZone,
    participants: updated.participants,
    ownerId: updated.ownerId,
    activityIds: updated.activityIds,
    createdAt: updated.createdAt,
    earliestStart: earliestStart,
    latestEnd: latestEnd,
    sourcePlanId: source,
    linkedActivityIds: updated.linkedActivityIds,
    linkStart: updated.linkStart,
    linkEnd: updated.linkEnd,
    hiddenFields: updated.hiddenFields,
  );
}

class PlanPlaceMapResult {
  final int? status;
  final Uint8List? bytes;

  const PlanPlaceMapResult({this.status, this.bytes});
}

class PlaceSuggestion {
  final String placeId;
  final String name;
  final String address;
  final String summary;

  const PlaceSuggestion({
    required this.placeId,
    required this.name,
    this.address = '',
    this.summary = '',
  });
}

class PlaceSearchResult {
  final int? status;
  final String? error;
  final List<PlaceSuggestion> places;

  const PlaceSearchResult({
    this.status,
    this.error,
    this.places = const [],
  });
}

class ActivityHistoryRevision {
  final String id;
  final String userId;
  final String action;
  final String createdAt;

  const ActivityHistoryRevision({
    required this.id,
    required this.userId,
    required this.action,
    required this.createdAt,
  });
}

class ActivityHistoryResult {
  final int? status;
  final String? error;
  final List<ActivityHistoryRevision> revisions;

  const ActivityHistoryResult({
    this.status,
    this.error,
    this.revisions = const [],
  });
}

class ActivityRestoreResult {
  final int? status;
  final String? error;

  const ActivityRestoreResult({this.status, this.error});
}

class ConfirmationParse {
  final int? status;
  final String? error;
  final Map<String, String> values;

  const ConfirmationParse({
    this.status,
    this.error,
    this.values = const {},
  });
}

class AiCommandResult {
  final int? status;
  final String? error;
  final String summary;
  final Map<String, dynamic> proposal;

  const AiCommandResult({
    this.status,
    this.error,
    this.summary = '',
    this.proposal = const {},
  });
}

class AiCommandApplyResult {
  final int? status;
  final String? error;

  const AiCommandApplyResult({this.status, this.error});
}

class OptimizeDayResult {
  final int? status;
  final String? error;
  final String summary;
  final List<Map<String, dynamic>> changes;

  const OptimizeDayResult({
    this.status,
    this.error,
    this.summary = '',
    this.changes = const [],
  });
}

class OptimizeDayApplyResult {
  final int? status;
  final String? error;

  const OptimizeDayApplyResult({this.status, this.error});
}

String _trimmed(dynamic value) {
  if (value == null) return '';
  return value.toString().trim();
}

String? _ownerIdFromBody(String body) {
  try {
    final data = json.decode(body);
    if (data is! Map) return null;
    final ownerId = data['ownerId'];
    if (ownerId == null) return null;
    final text = ownerId.toString().trim();
    return text.isEmpty ? null : text;
  } catch (_) {
    return null;
  }
}

String? _apiErrorMessage(String body) {
  try {
    final data = json.decode(body);
    if (data is! Map) return null;
    final msg = data['msg'] ?? data['message'];
    if (msg == null) return null;
    final text = msg.toString().trim();
    return text.isEmpty ? null : text;
  } catch (_) {
    return null;
  }
}

String? _apiText(Map data, String key) {
  final value = data[key];
  if (value is! String) return null;
  final text = value.trim();
  return text.isEmpty ? null : text;
}

String _personName(Map item) {
  final first = _trimmed(item['firstName']);
  final last = _trimmed(item['lastName']);
  return [
    if (first.isNotEmpty) first,
    if (last.isNotEmpty) last,
  ].join(' ');
}

String _personLabel(Map item) {
  final name = _personName(item);
  final email = _trimmed(item['email']);
  final who = name.isNotEmpty ? name : email;
  if (who.isEmpty) return '';
  final role = _trimmed(item['role']);
  return role.isEmpty ? who : '$who ($role)';
}

String _inviteLabel(Map item) {
  final email = _trimmed(item['email']);
  final role = _trimmed(item['role']);
  if (email.isEmpty && role.isEmpty) return '';
  if (email.isEmpty) return 'Invited $role';
  if (role.isEmpty) return '$email (invited)';
  return '$email (invited $role)';
}

List<String> _sharedWithLabels(String body) {
  final dynamic data;
  try {
    data = json.decode(body);
  } catch (e) {
    return [];
  }
  if (data is! Map) return [];
  final labels = <String>[];
  final people = data['people'];
  if (people is List) {
    for (final item in people) {
      if (item is! Map) continue;
      final label = _personLabel(item);
      if (label.isNotEmpty) labels.add(label);
    }
  }
  final invites = data['invites'];
  if (invites is List) {
    for (final item in invites) {
      if (item is! Map) continue;
      final label = _inviteLabel(item);
      if (label.isNotEmpty) labels.add(label);
    }
  }
  return labels;
}

class PlanProvider extends ChangeNotifier {
  List<Plan> _plans = []; // Private list of plans
  List<PlanTemplate> _templates = [];
  bool _templatesLoading = false;
  String? _templatesError;
  Plan? _currentPlan; // Current selected plan
  Plan? get currentPlan => _currentPlan;
  List<Activity> _activities = []; // Private list of activities for the current plan
  bool _isLoading = false; // Loading state for UI spinners

  List<Plan> get plans => _plans; // Public getter
  List<PlanTemplate> get templates => _templates;
  bool get templatesLoading => _templatesLoading;
  String? get templatesError => _templatesError;
  List<Activity> get activities => _activities;
  List<PlanUser> _planUsers =
      []; // Private list of users/roles for current plan
  List<PlanUser> get planUsers => _planUsers;
  List<PlanMember> _planMembers = [];
  List<PlanMember> get planMembers => _planMembers;
  bool get isLoading => _isLoading;

  String? _currentPlanId; // Track current plan for itinerary
  final Map<String, String> _viewerRoles = {};

  /// Stored Owner, Collaborator, or Guest for the signed-in user on this plan.
  /// Owner is known from ownerId. Other roles come from GET /api/plans/:id/users.
  String? viewerStoredRole(String planId, String? userId) {
    final fetched = _viewerRoles[planId];
    if (fetched != null && fetched.isNotEmpty) return fetched;
    if (userId == null || userId.isEmpty) return null;
    for (final plan in _plans) {
      if (plan.id == planId && plan.ownerId == userId) return 'Owner';
    }
    return null;
  }

  /// Plan type already loaded from GET /api/plans, when this plan is one of them.
  String? planTypeFor(String planId) {
    for (final plan in _plans) {
      if (plan.id == planId) {
        final type = plan.type.trim();
        return type.isEmpty ? null : type;
      }
    }
    return null;
  }

  List<Activity>? _readItinerary(String body) {
    final dynamic data = json.decode(body);
    if (data is! Map || data['events'] is! List) return null;
    final parsed = <Activity>[];
    for (final item in data['events'] as List) {
      if (item is! Map) continue;
      parsed.add(Activity.fromJson(_itineraryActivityJson(item)));
    }
    return parsed.any((activity) => activity.linked)
        ? _sortedByStartTime(parsed)
        : parsed;
  }

  void _storeItinerary(List<Activity> ordered) {
    _itinerary = ordered;
    _activities = List<Activity>.from(ordered);
    _itineraryError = null;
  }

  /// Shows a previously saved itinerary. Does not call the network.
  void showSavedItinerary(List<Activity> activities) {
    _storeItinerary(activities);
    _activityWarnings = [];
    _activityReactions = {};
    notifyListeners();
  }

  /// GET the itinerary and replace the open list. Does not show the page spinner.
  Future<int?> refreshItinerary(String planId, String? token) async {
    if (planId.isEmpty) return null;
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.get(
        Uri.parse(
          backendBaseUrl + apiPlansItinerary.replaceAll('{planId}', planId),
        ),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) return response.statusCode;
      final ordered = _readItinerary(response.body);
      if (ordered == null) return response.statusCode;
      _storeItinerary(ordered);
      await _loadActivityWarnings(planId, token);
      await _loadActivityReactions(token);
      notifyListeners();
      return 200;
    } catch (e) {
      logger.e('Error refreshing itinerary: $e');
      return null;
    }
  }

  // GET /api/plans/:planId/itinerary. 200 with an empty list is not an error.
  Future<int?> fetchPlan(String planId, String? token) async {
    _currentPlanId = planId;
    _isLoading = true;
    _itinerary = [];
    _itineraryError = null;
    _activityWarnings = [];
    _activityReactions = {};
    _planMembers = [];
    notifyListeners();

    try {
      if (token == null || token.isEmpty) {
        _itineraryError = 'Session expired';
        return 401;
      }

      final response = await http.get(
        Uri.parse(
          (backendBaseUrl) +
              apiPlansItinerary.replaceAll('{planId}', planId),
        ),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (response.statusCode == 401) {
        _itineraryError = 'Session expired';
        return 401;
      }
      if (response.statusCode == 403) {
        final message = _apiErrorMessage(response.body);
        _itineraryError = message == archivedPlanMessage
            ? archivedPlanMessage
            : 'Not allowed to view this itinerary';
        return 403;
      }
      if (response.statusCode != 200) {
        _itineraryError = 'Could not load activities (${response.statusCode})';
        return response.statusCode;
      }

      final ordered = _readItinerary(response.body);
      if (ordered == null) {
        _itineraryError = 'Could not load activities';
        return response.statusCode;
      }
      _storeItinerary(ordered);
      await _loadActivityWarnings(planId, token);
      await _loadActivityReactions(token);
      logger.i('Fetched ${_itinerary.length} activities for plan $planId');
      return 200;
    } catch (e) {
      logger.e('Error fetching itinerary: $e');
      _itinerary = [];
      _activityWarnings = [];
      _activityReactions = {};
      _itineraryError = 'Could not load activities';
      return null;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  String? _plansError;
  String? _writeMessage;
  String? _upgradePack;
  String? _upgradeTierName;
  List<Activity> _itinerary = [];
  List<ActivityWarning> _activityWarnings = [];
  Map<String, ActivityReactions> _activityReactions = {};
  String? _itineraryError;

  String? get plansError => _plansError;
  String? get writeMessage => _writeMessage;
  String? get upgradePack => _upgradePack;
  String? get upgradeTierName => _upgradeTierName;

  void _readUpgrade(String body) {
    _upgradePack = null;
    _upgradeTierName = null;
    try {
      final data = json.decode(body);
      if (data is! Map) return;
      final tier = _apiText(data, 'nextTier');
      _upgradePack = checkoutPackForTier(tier);
      _upgradeTierName = _apiText(data, 'nextTierName');
    } catch (_) {}
  }
  List<Activity> get itineraryActivities => _itinerary;

  /// Warnings whose row is this activity. Empty when the id is blank.
  List<ActivityWarning> warningsFor(String? activityId) {
    final id = activityId?.trim() ?? '';
    if (id.isEmpty) return const [];
    return [
      for (final warning in _activityWarnings)
        if (warning.activityId == id && warning.message.isNotEmpty) warning,
    ];
  }

  Future<void> _loadActivityWarnings(String planId, String? token) async {
    if (planId.isEmpty || token == null || token.isEmpty) {
      _activityWarnings = [];
      return;
    }
    try {
      final response = await http.get(
        Uri.parse(
          backendBaseUrl + apiPlanWarnings.replaceAll('{planId}', planId),
        ),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) return;
      final data = json.decode(response.body);
      if (data is! Map || data['warnings'] is! List) return;
      _activityWarnings = [
        for (final item in data['warnings'])
          if (item is Map)
            ActivityWarning.fromJson(Map<String, dynamic>.from(item)),
      ];
    } catch (e) {
      logger.e('Error fetching activity warnings: $e');
    }
  }

  /// Replaces the counts for one activity from a plan-room reaction event.
  /// Does not reload the itinerary. Highlight changes only when [userId] is
  /// [currentUserId].
  void applyRemoteReaction({
    required String activityId,
    required Map<String, int> counts,
    required String type,
    required String userId,
    required bool? voted,
    String? currentUserId,
  }) {
    final id = activityId.trim();
    if (id.isEmpty) return;
    final current = _activityReactions[id] ?? ActivityReactions.empty;
    _activityReactions = {
      ..._activityReactions,
      id: current.applyLive(
        counts: counts,
        type: type,
        actorId: userId,
        currentUserId: currentUserId,
        voted: voted,
      ),
    };
    notifyListeners();
  }

  /// Counts and this person's votes. Empty until the itinerary has loaded them.
  ActivityReactions reactionsFor(String? activityId) {
    final id = activityId?.trim() ?? '';
    if (id.isEmpty) return ActivityReactions.empty;
    return _activityReactions[id] ?? ActivityReactions.empty;
  }

  Future<void> _loadActivityReactions(String? token) async {
    if (token == null || token.isEmpty) {
      _activityReactions = {};
      return;
    }
    final ids = <String>[
      for (final activity in _itinerary)
        if (activity.id != null && activity.id!.isNotEmpty) activity.id!,
    ];
    if (ids.isEmpty) {
      _activityReactions = {};
      return;
    }
    try {
      final loaded = await Future.wait([
        for (final id in ids) _fetchActivityReactions(id, token),
      ]);
      final next = <String, ActivityReactions>{};
      for (var index = 0; index < ids.length; index++) {
        final summary = loaded[index];
        if (summary != null) next[ids[index]] = summary;
      }
      _activityReactions = next;
    } catch (e) {
      logger.e('Error fetching activity reactions: $e');
    }
  }

  Future<ActivityReactions?> _fetchActivityReactions(
    String activityId,
    String token,
  ) async {
    try {
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/reactions'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      if (response.statusCode != 200) return null;
      final data = json.decode(response.body);
      if (data is! Map) return null;
      return ActivityReactions.fromJson(Map<String, dynamic>.from(data));
    } catch (e) {
      logger.e('Error fetching reactions for $activityId: $e');
      return null;
    }
  }

  void _storeReactionSummary(String activityId, String body) {
    final data = json.decode(body);
    if (data is! Map) return;
    _activityReactions = {
      ..._activityReactions,
      activityId: ActivityReactions.fromJson(Map<String, dynamic>.from(data)),
    };
    notifyListeners();
  }

  Future<ActivityReactionResult> _sendActivityReaction({
    required String activityId,
    required String type,
    required String? token,
    required bool remove,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityReactionResult(status: 401);
      }
      final uri = Uri.parse('$backendBaseUrl$apiActivities/$activityId/react');
      final headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };
      final body = json.encode({'type': type});
      final response = remove
          ? await http.delete(uri, headers: headers, body: body)
          : await http.post(uri, headers: headers, body: body);
      if (response.statusCode != 200) {
        return ActivityReactionResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      _storeReactionSummary(activityId, response.body);
      return const ActivityReactionResult(status: 200);
    } catch (e) {
      logger.e('Error saving an activity reaction: $e');
      return const ActivityReactionResult();
    }
  }

  /// POST /api/activities/:id/react. A second vote of the same type replaces it.
  Future<ActivityReactionResult> setActivityReaction({
    required String activityId,
    required String type,
    required String? token,
  }) {
    return _sendActivityReaction(
      activityId: activityId,
      type: type,
      token: token,
      remove: false,
    );
  }

  /// DELETE /api/activities/:id/react. Clears this person's vote of that type.
  Future<ActivityReactionResult> clearActivityReaction({
    required String activityId,
    required String type,
    required String? token,
  }) {
    return _sendActivityReaction(
      activityId: activityId,
      type: type,
      token: token,
      remove: true,
    );
  }

  /// POST /api/activities/:id/poll. Owner or Collaborator. Does not add an activity.
  Future<ActivityReactionResult> startActivityPoll({
    required String activityId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityReactionResult(status: 401);
      }
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/poll'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: '{}',
      );
      if (response.statusCode != 200) {
        return ActivityReactionResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      _itinerary = [
        for (final activity in _itinerary)
          if (activity.id == activityId) activity.withPoll(true) else activity,
      ];
      _activities = List<Activity>.from(_itinerary);
      notifyListeners();
      return const ActivityReactionResult(status: 200);
    } catch (e) {
      logger.e('Error starting an activity poll: $e');
      return const ActivityReactionResult();
    }
  }

  /// Shows [activities] in start-time order. Does not call the API.
  /// Drag uses this so the moved row sits after its target once its start is later.
  void replaceItineraryActivities(List<Activity> activities) {
    final next = _sortedByStartTime(activities);
    _itinerary = next;
    _activities = List<Activity>.from(next);
    notifyListeners();
  }

  /// Shows [activities] in the given order. Does not change start or end times.
  void showItinerary(List<Activity> activities) {
    _itinerary = List<Activity>.from(activities);
    _activities = List<Activity>.from(activities);
    notifyListeners();
  }

  /// PUT /api/activities/:id/move. Reorders [activityIds] and applies the time chain.
  Future<int?> moveActivity({
    required String planId,
    required String activityId,
    required List<String> activityIds,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.put(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/move'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'planId': planId,
          'activityIds': activityIds,
        }),
      );
      if (response.statusCode == 200) {
        await refreshItinerary(planId, token);
      }
      return response.statusCode;
    } catch (e) {
      logger.e('Error moving activity: $e');
      return null;
    }
  }

  /// PUT /api/activities/order. Stores [activityIds] as the itinerary order.
  /// Does not send or change start or end times.
  Future<int?> saveItineraryOrder({
    required String planId,
    required List<String> activityIds,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.put(
        Uri.parse('$backendBaseUrl$apiActivities/order'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'planId': planId,
          'activityIds': activityIds,
        }),
      );
      return response.statusCode;
    } catch (e) {
      logger.e('Error saving itinerary order: $e');
      return null;
    }
  }

  /// Orders the loaded itinerary by start time and stores that order.
  /// An activity with no start stays last. Start and end instants stay as they are.
  Future<int?> resortItineraryByStartTime({
    required String planId,
    required String? token,
  }) async {
    final ordered = _sortedByStartTime(_itinerary);
    if (ordered.isEmpty) return 200;
    final activityIds = <String>[];
    for (final activity in ordered) {
      final id = activity.id;
      if (id == null || id.isEmpty) return null;
      activityIds.add(id);
    }
    final status = await saveItineraryOrder(
      planId: planId,
      activityIds: activityIds,
      token: token,
    );
    if (status == 200) showItinerary(ordered);
    return status;
  }
  String? get itineraryError => _itineraryError;

  void clearPlans() {
    _plans = [];
    _templates = [];
    _templatesLoading = false;
    _templatesError = null;
    _viewerRoles.clear();
    _plansError = null;
    _itinerary = [];
    _activityWarnings = [];
    _itineraryError = null;
    _planMembers = [];
    _isLoading = false;
    notifyListeners();
  }

  // GET /api/plans. 200 with { plans: [] } is an empty list, not an error.
  // Returns the HTTP status, or null when the call did not finish.
  Future<int?> fetchPlans(String? token) async {
    _isLoading = true;
    _plansError = null;
    notifyListeners();

    try {
      if (token == null || token.isEmpty) {
        _plansError = 'Session expired';
        return 401;
      }

      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiPlans?includeArchived=1'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (response.statusCode == 401) {
        _plansError = 'Session expired';
        return 401;
      }

      if (response.statusCode != 200) {
        _plansError = 'Could not load plans (${response.statusCode})';
        return response.statusCode;
      }

      final dynamic data = json.decode(response.body);
      if (data is! Map || data['plans'] is! List) {
        _plansError = 'Could not load plans';
        return response.statusCode;
      }

      final parsed = <Plan>[];
      for (final item in data['plans'] as List) {
        if (item is! Map) continue;
        parsed.add(Plan.fromJson(Map<String, dynamic>.from(item)));
      }
      _plans = parsed;
      _plansError = null;
      logger.i('Parsed ${_plans.length} plans from backend');
      return 200;
    } catch (e) {
      logger.e('Error fetching plans: $e');
      _plansError = 'Could not load plans';
      return null;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// Fills viewerStoredRole from GET /api/plans/:planId/users. Does not change
  /// the plan list request. Returns 401 when the token is rejected.
  Future<int?> loadViewerRoles(String? token, String? userId) async {
    if (token == null || token.isEmpty) return 401;
    final plans = List<Plan>.from(_plans);
    if (userId == null || userId.isEmpty || plans.isEmpty) return 200;

    final next = <String, String>{};
    final pending = <Future<int?>>[];
    for (final plan in plans) {
      if (plan.ownerId == userId) {
        next[plan.id] = 'Owner';
        continue;
      }
      if (plan.isArchived) continue;
      pending.add(_readMembershipRole(plan.id, token, userId, next));
    }
    final codes = await Future.wait(pending);
    _viewerRoles
      ..clear()
      ..addAll(next);
    notifyListeners();
    if (codes.contains(401)) return 401;
    return 200;
  }

  Future<int?> _readMembershipRole(
    String planId,
    String token,
    String userId,
    Map<String, String> into,
  ) async {
    try {
      final response = await http.get(
        Uri.parse(
          (backendBaseUrl) + apiPlanUsers.replaceAll('{planId}', planId),
        ),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode == 401) return 401;
      if (response.statusCode != 200) return response.statusCode;
      final role = _roleFromUsersBody(response.body, userId);
      if (role != null && role.isNotEmpty) into[planId] = role;
      return 200;
    } catch (e) {
      logger.e('Error reading membership role: $e');
      return null;
    }
  }

  /// GET /api/plans/:planId/members. Accepted people and pending invitations.
  Future<int?> fetchPlanMembers(String planId, String? token) async {
    try {
      if (token == null || token.isEmpty) {
        _planMembers = [];
        notifyListeners();
        return 401;
      }

      final response = await http.get(
        Uri.parse(
          backendBaseUrl + apiPlanMembers.replaceAll('{planId}', planId),
        ),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (response.statusCode == 401) {
        _planMembers = [];
        notifyListeners();
        return 401;
      }
      if (response.statusCode != 200) {
        _planMembers = [];
        notifyListeners();
        return response.statusCode;
      }

      final dynamic data = json.decode(response.body);
      if (data is! Map || data['members'] is! List) {
        _planMembers = [];
        notifyListeners();
        return response.statusCode;
      }

      final parsed = <PlanMember>[];
      for (final item in data['members'] as List) {
        if (item is! Map) continue;
        parsed.add(PlanMember.fromJson(Map<String, dynamic>.from(item)));
      }
      _planMembers = parsed;
      logger.i('Fetched ${_planMembers.length} members for plan $planId');
      notifyListeners();
      return 200;
    } catch (e) {
      logger.e('Error fetching plan members: $e');
      _planMembers = [];
      notifyListeners();
      return null;
    }
  }

  // Fetch PlanUsers for a plan (GET /api/plans/:planId/users with token)
  Future<void> fetchPlanUsers(String planId, String? token) async {
    _isLoading = true; // Optional: Show loading in UI
    notifyListeners();

    try {
      if (token == null) throw Exception('No token—log in first');

      final response = await http.get(
        Uri.parse('$backendBaseUrl/api/plans/$planId/users'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );

      logger.i(
        'Fetch PlanUsers response: ${response.statusCode}',
      ); // Debug optional

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        _planUsers = data
            .map((json) => PlanUser.fromJson(json))
            .toList(); // Parse to List<PlanUser>
        logger.i('Fetched ${_planUsers.length} PlanUsers for plan $planId');
      } else {
        throw Exception('Failed to load PlanUsers: ${response.statusCode}');
      }
    } catch (e) {
      logger.e('Error fetching PlanUsers: $e');
      _planUsers = []; // Empty fallback
    } finally {
      _isLoading = false;
      notifyListeners(); // Refresh UI (e.g., list in PlanDetailScreen)
    }
  }

  // POST /api/plans. Returns the HTTP status, or null when the call did not finish.
  Future<int?> createPlan(Plan newPlan, String? token) async {
    try {
      _writeMessage = null;
      _upgradePack = null;
      _upgradeTierName = null;
      if (token == null || token.isEmpty) {
        return 401;
      }

      final response = await http.post(
        Uri.parse(backendBaseUrl + apiPlans),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(newPlan.toJson()),
      );

      if (response.statusCode != 201) {
        _writeMessage = _apiErrorMessage(response.body);
        _readUpgrade(response.body);
        return response.statusCode;
      }
      _writeMessage = null;

      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) {
        return response.statusCode;
      }
      final createdPlan = Plan.fromJson(Map<String, dynamic>.from(planJson));
      _plans = [..._plans, createdPlan];
      _plansError = null;
      notifyListeners();
      logger.i('Created plan: ${createdPlan.name} from backend');
      return 201;
    } catch (e) {
      logger.e('Error creating plan: $e');
      return null;
    }
  }

  void _replacePlan(Plan next) {
    final updated = <Plan>[];
    var found = false;
    for (final plan in _plans) {
      if (plan.id == next.id) {
        updated.add(next);
        found = true;
      } else {
        updated.add(plan);
      }
    }
    if (!found) updated.add(next);
    _plans = updated;
    notifyListeners();
  }

  Future<int?> _postPlanAction({
    required String planId,
    required String action,
    required String? token,
    Map<String, dynamic>? body,
  }) async {
    try {
      _writeMessage = null;
      _upgradePack = null;
      _upgradeTierName = null;
      if (token == null || token.isEmpty) return 401;
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiPlans/$planId/$action'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(body ?? const {}),
      );
      if (response.statusCode != 200) {
        _writeMessage = _apiErrorMessage(response.body);
        _readUpgrade(response.body);
        return response.statusCode;
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is Map) {
        _replacePlan(Plan.fromJson(Map<String, dynamic>.from(planJson)));
      }
      return 200;
    } catch (e) {
      logger.e('Error on plan $action: $e');
      return null;
    }
  }

  /// POST /api/plans/:planId/archive. Owner only.
  Future<int?> archivePlan({
    required String planId,
    required String description,
    required String? token,
  }) {
    return _postPlanAction(
      planId: planId,
      action: 'archive',
      token: token,
      body: {'description': description},
    );
  }

  /// POST /api/plans/:planId/copy. Owner only. 201 adds the new plan to the list.
  Future<PlanLinkResult> copyPlan({
    required String planId,
    required String? name,
    required String? token,
  }) async {
    try {
      _writeMessage = null;
      _upgradePack = null;
      _upgradeTierName = null;
      if (token == null || token.isEmpty) {
        return const PlanLinkResult(status: 401);
      }
      final body = <String, dynamic>{};
      final trimmed = name?.trim() ?? '';
      if (trimmed.isNotEmpty) body['name'] = trimmed;
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiPlans/$planId/copy'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(body),
      );
      if (response.statusCode != 201) {
        _writeMessage = _apiErrorMessage(response.body);
        _readUpgrade(response.body);
        return PlanLinkResult(
          status: response.statusCode,
          error: _writeMessage,
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) {
        return PlanLinkResult(status: response.statusCode);
      }
      final created = Plan.fromJson(Map<String, dynamic>.from(planJson));
      _replacePlan(created);
      if (token.isNotEmpty) {
        _viewerRoles[created.id] = 'Owner';
      }
      return PlanLinkResult(status: 201, plan: created);
    } catch (e) {
      logger.e('Error copying plan: $e');
      return const PlanLinkResult();
    }
  }

  /// GET /api/templates. Does not replace the plan list or its loading flag.
  Future<int?> fetchTemplates(String? token) async {
    _templatesLoading = true;
    _templatesError = null;
    notifyListeners();
    try {
      if (token == null || token.isEmpty) {
        _templates = [];
        return 401;
      }
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiTemplates'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        _templatesError = _apiErrorMessage(response.body) ?? 'Could not load templates';
        return response.statusCode;
      }
      final data = json.decode(response.body);
      final rows = data is Map ? data['templates'] : null;
      _templates = rows is List
          ? rows
              .whereType<Map>()
              .map((row) => PlanTemplate.fromJson(Map<String, dynamic>.from(row)))
              .where((row) => row.id.isNotEmpty)
              .toList()
          : <PlanTemplate>[];
      _templatesError = null;
      return 200;
    } catch (e) {
      logger.e('Error fetching templates: $e');
      _templatesError = 'Could not load templates';
      return null;
    } finally {
      _templatesLoading = false;
      notifyListeners();
    }
  }

  /// POST /api/plans/:planId/save-as-template. Owner only. Does not change the plan.
  Future<int?> saveAsTemplate({
    required String planId,
    required String name,
    required String description,
    required String? token,
  }) async {
    try {
      _writeMessage = null;
      _upgradePack = null;
      _upgradeTierName = null;
      if (token == null || token.isEmpty) return 401;
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiPlans/$planId/save-as-template'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': name,
          'description': description,
        }),
      );
      if (response.statusCode != 201) {
        _writeMessage = _apiErrorMessage(response.body);
        return response.statusCode;
      }
      return 201;
    } catch (e) {
      logger.e('Error saving template: $e');
      return null;
    }
  }

  /// POST /api/templates/:templateId/create-plan. 201 adds the new plan.
  Future<PlanLinkResult> createPlanFromTemplate({
    required String templateId,
    required String name,
    required String startDate,
    required String? token,
  }) async {
    try {
      _writeMessage = null;
      _upgradePack = null;
      _upgradeTierName = null;
      if (token == null || token.isEmpty) {
        return const PlanLinkResult(status: 401);
      }
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiTemplates/$templateId/create-plan'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': name,
          'startDate': startDate,
        }),
      );
      if (response.statusCode != 201) {
        _writeMessage = _apiErrorMessage(response.body);
        _readUpgrade(response.body);
        return PlanLinkResult(
          status: response.statusCode,
          error: _writeMessage,
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) {
        return PlanLinkResult(status: response.statusCode);
      }
      final created = Plan.fromJson(Map<String, dynamic>.from(planJson));
      _replacePlan(created);
      _viewerRoles[created.id] = 'Owner';
      return PlanLinkResult(status: 201, plan: created);
    } catch (e) {
      logger.e('Error creating plan from template: $e');
      return const PlanLinkResult();
    }
  }

  /// POST /api/plans/:planId/recall. Owner or accepted Co-Planner.
  Future<int?> recallPlan({
    required String planId,
    required String? token,
  }) {
    return _postPlanAction(
      planId: planId,
      action: 'recall',
      token: token,
    );
  }

  /// GET /api/plans/:planId. Does not replace the open plan list or itinerary.
  Future<PlanRead> readPlan({
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanRead(status: 401);
      }
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiPlans/$planId'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return PlanRead(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) return PlanRead(status: response.statusCode);
      return PlanRead(
        status: 200,
        plan: Plan.fromJson(Map<String, dynamic>.from(planJson)),
      );
    } catch (e) {
      logger.e('Error reading plan: $e');
      return const PlanRead();
    }
  }

  /// GET /api/plans/:planId/members without replacing the open people list.
  Future<PlanMembersRead> readPlanMembers({
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanMembersRead(status: 401);
      }
      final response = await http.get(
        Uri.parse(
          '$backendBaseUrl${apiPlanMembers.replaceAll('{planId}', planId)}',
        ),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return PlanMembersRead(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final members = data is Map ? data['members'] : null;
      if (members is! List) return PlanMembersRead(status: response.statusCode);
      final parsed = <PlanMember>[];
      for (final item in members) {
        if (item is! Map) continue;
        parsed.add(PlanMember.fromJson(Map<String, dynamic>.from(item)));
      }
      return PlanMembersRead(status: 200, members: parsed);
    } catch (e) {
      logger.e('Error reading plan members: $e');
      return const PlanMembersRead();
    }
  }

  /// GET /api/plans/:planId/itinerary without replacing the open itinerary.
  Future<PlanItineraryRead> readItinerary({
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanItineraryRead(status: 401);
      }
      final response = await http.get(
        Uri.parse(
          '$backendBaseUrl${apiPlansItinerary.replaceAll('{planId}', planId)}',
        ),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return PlanItineraryRead(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final events = data is Map ? data['events'] : null;
      if (events is! List) {
        return PlanItineraryRead(status: response.statusCode);
      }
      final activities = <Activity>[];
      for (final item in events) {
        if (item is! Map) continue;
        activities.add(Activity.fromJson(_itineraryActivityJson(item)));
      }
      return PlanItineraryRead(status: 200, activities: activities);
    } catch (e) {
      logger.e('Error reading itinerary: $e');
      return const PlanItineraryRead();
    }
  }

  /// POST /api/plans/:planId/link. The new plan is owned by the caller.
  Future<PlanLinkResult> linkPersonalPlan({
    required String planId,
    required List<String> activityIds,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanLinkResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          '$backendBaseUrl${apiPlanLink.replaceAll('{planId}', planId)}',
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'activityIds': activityIds}),
      );
      if (response.statusCode != 201) {
        return PlanLinkResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) return const PlanLinkResult(status: 201);
      final parsed = Plan.fromJson(Map<String, dynamic>.from(planJson));
      final sourceId = parsed.sourcePlanId.trim().isNotEmpty
          ? parsed.sourcePlanId
          : planId;
      final created = _planWithSourceId(parsed, sourceId);
      _viewerRoles[created.id] = 'Owner';
      final stored = storeReturnedPlan(created);
      return PlanLinkResult(status: 201, plan: stored);
    } catch (e) {
      logger.e('Error linking a personal plan: $e');
      return const PlanLinkResult();
    }
  }

  /// Keeps [updated] on the open plan list. A blank sourcePlanId leaves the
  /// saved link in place. A plan that was not in the list is added.
  Plan storeReturnedPlan(Plan updated) {
    Plan? previous;
    for (final plan in _plans) {
      if (plan.id == updated.id) {
        previous = plan;
        break;
      }
    }
    final keptSource = updated.sourcePlanId.trim().isNotEmpty
        ? updated.sourcePlanId
        : (previous?.sourcePlanId ?? '');
    final stored = previous == null
        ? updated
        : _planKeepingActivitySpan(
            updated,
            previous,
            sourcePlanId: keptSource,
          );
    if (previous == null) {
      _plans = [..._plans, stored];
    } else {
      _plans = [
        for (final plan in _plans)
          if (plan.id == updated.id) stored else plan,
      ];
    }
    notifyListeners();
    return stored;
  }

  /// PUT /api/plans/:planId/link. Replaces the selected source activities.
  Future<PlanLinkResult> updateLinkedActivities({
    required String planId,
    required List<String> activityIds,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanLinkResult(status: 401);
      }
      final response = await http.put(
        Uri.parse(
          '$backendBaseUrl${apiPlanLink.replaceAll('{planId}', planId)}',
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'activityIds': activityIds}),
      );
      if (response.statusCode != 200) {
        return PlanLinkResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) return const PlanLinkResult(status: 200);
      final updated = Plan.fromJson(Map<String, dynamic>.from(planJson));
      final stored = storeReturnedPlan(updated);
      return PlanLinkResult(status: 200, plan: stored);
    } catch (e) {
      logger.e('Error updating linked activities: $e');
      return const PlanLinkResult();
    }
  }

  /// Reloads one plan from GET /api/plans without the list spinner.
  Future<void> _reloadPlan(String planId, String token) async {
    try {
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiPlans'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) return;
      final data = json.decode(response.body);
      final list = data is Map ? data['plans'] : null;
      if (list is! List) return;
      Plan? match;
      for (final item in list) {
        if (item is! Map) continue;
        final plan = Plan.fromJson(Map<String, dynamic>.from(item));
        if (plan.id == planId) match = plan;
      }
      if (match == null) return;
      final updated = match;
      _plans = [
        for (final plan in _plans)
          if (plan.id == planId) updated else plan,
      ];
      notifyListeners();
    } catch (e) {
      logger.e('Error reloading plan: $e');
    }
  }

  /// POST /api/activities/parse-confirmation. Reads pasted text and does not save.
  Future<ConfirmationParse> parseConfirmation({
    required String text,
    required String type,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ConfirmationParse(status: 401);
      }
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiActivities/parse-confirmation'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'text': text, 'type': type}),
      );
      if (response.statusCode != 200) {
        return ConfirmationParse(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      if (data is! Map) return ConfirmationParse(status: response.statusCode);
      const keys = [
        'bookingReference',
        'confirmation',
        'origin',
        'destination',
        'name',
        'start',
        'end',
      ];
      final values = <String, String>{};
      for (final key in keys) {
        final value = data[key];
        if (value is! String) continue;
        final trimmed = value.trim();
        if (trimmed.isEmpty) continue;
        values[key] = trimmed;
      }
      return ConfirmationParse(status: 200, values: values);
    } catch (e) {
      logger.e('Error parsing confirmation: $e');
      return const ConfirmationParse();
    }
  }

  /// POST /api/activities. The body keeps shared fields and the selected type's fields.
  /// On 201 the returned activity is inserted at [insertIndex], or appended when that is omitted.
  Future<int?> createActivity({
    required String planId,
    required String name,
    required String type,
    required DateTime startTime,
    required DateTime endTime,
    required String timeZone,
    required String startTimeZone,
    required String endTimeZone,
    required String location,
    required String googlePlaceId,
    required String details,
    required String bookingReference,
    double? cost,
    required String costType,
    String? gate,
    String? baggageClaim,
    String? roomNumber,
    String? origin,
    String? originCountry,
    String? destination,
    String? confirmation,
    int? durationMinutes,
    String? insertAfter,
    String? insertBefore,
    int? insertIndex,
    List<FlightLeg>? legs,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.post(
        Uri.parse((backendBaseUrl) + apiActivities),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(
          _activityWriteBody(
            name: name,
            type: type,
            startTime: startTime,
            endTime: endTime,
            timeZone: timeZone,
            startTimeZone: startTimeZone,
            endTimeZone: endTimeZone,
            location: location,
            googlePlaceId: googlePlaceId,
            details: details,
            bookingReference: bookingReference,
            cost: cost,
            costType: costType,
            gate: gate,
            baggageClaim: baggageClaim,
            roomNumber: roomNumber,
            origin: origin,
            originCountry: originCountry,
            destination: destination,
            confirmation: confirmation,
            planId: planId,
            durationMinutes: durationMinutes,
            insertAfter: insertAfter,
            insertBefore: insertBefore,
            legs: legs,
          ),
        ),
      );
      if (response.statusCode != 201) {
        _writeMessage = _apiErrorMessage(response.body);
        return response.statusCode;
      }
      _writeMessage = null;

      final dynamic data = json.decode(response.body);
      final refreshed = await refreshItinerary(planId, token);
      if (refreshed != 200 && data is Map) {
        final created = Activity.fromJson(_itineraryActivityJson(data));
        final mixesLinked = _itinerary.any((activity) => activity.linked) ||
            _plans.any(
              (plan) => plan.id == planId && plan.linkedActivityIds.isNotEmpty,
            );
        final next = List<Activity>.from(_itinerary);
        if (insertIndex == null || insertIndex < 0 || insertIndex > next.length) {
          next.add(created);
        } else {
          next.insert(insertIndex, created);
        }
        final shown = mixesLinked ? _sortedByStartTime(next) : next;
        _itinerary = shown;
        _activities = List<Activity>.from(shown);
        await _loadActivityWarnings(planId, token);
        await _loadActivityReactions(token);
        notifyListeners();
      }
      await _reloadPlan(planId, token);
      return 201;
    } catch (e) {
      logger.e('Error creating activity: $e');
      return null;
    }
  }

  /// PUT /api/activities/:id. The body keeps shared fields and the selected type's fields.
  /// On 200 the returned activity replaces that row and the list keeps its order.
  Future<int?> updateActivity({
    required String activityId,
    required String name,
    required String type,
    DateTime? startTime,
    DateTime? endTime,
    required String timeZone,
    required String startTimeZone,
    required String endTimeZone,
    required String location,
    required String googlePlaceId,
    required String details,
    required String bookingReference,
    double? cost,
    required String costType,
    String? gate,
    String? baggageClaim,
    String? roomNumber,
    String? origin,
    String? originCountry,
    String? destination,
    String? confirmation,
    int? durationMinutes,
    bool? writeStartTime,
    bool? writeEndTime,
    bool? writeDuration,
    List<FlightLeg>? legs,
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.put(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(
          _activityWriteBody(
            name: name,
            type: type,
            startTime: startTime,
            endTime: endTime,
            timeZone: timeZone,
            startTimeZone: startTimeZone,
            endTimeZone: endTimeZone,
            location: location,
            googlePlaceId: googlePlaceId,
            details: details,
            bookingReference: bookingReference,
            cost: cost,
            costType: costType,
            gate: gate,
            baggageClaim: baggageClaim,
            roomNumber: roomNumber,
            origin: origin,
            originCountry: originCountry,
            destination: destination,
            confirmation: confirmation,
            durationMinutes: durationMinutes,
            writeStartTime: writeStartTime,
            writeEndTime: writeEndTime,
            writeDuration: writeDuration,
            legs: legs,
          ),
        ),
      );
      if (response.statusCode != 200) {
        _writeMessage = _apiErrorMessage(response.body);
        return response.statusCode;
      }
      _writeMessage = null;

      final dynamic data = json.decode(response.body);
      final refreshed = planId.isEmpty
          ? null
          : await refreshItinerary(planId, token);
      if (refreshed != 200 && data is Map) {
        final updated = Activity.fromJson(_itineraryActivityJson(data));
        final next = [
          for (final activity in _itinerary)
            if (activity.id == activityId) updated else activity,
        ];
        final shown = next.any((activity) => activity.linked)
            ? _sortedByStartTime(next)
            : next;
        _itinerary = shown;
        _activities = List<Activity>.from(shown);
        await _loadActivityWarnings(planId, token);
        await _loadActivityReactions(token);
        notifyListeners();
      }
      if (planId.isNotEmpty) await _reloadPlan(planId, token);
      return 200;
    } catch (e) {
      logger.e('Error updating activity: $e');
      return null;
    }
  }

  /// PUT /api/plans/:planId with name, destination, budget, dates, time zone,
  /// the auto-calculate flags, and the fields hidden from guests.
  /// A null budget clears the stored amount.
  /// On 200 that plan is replaced, then reloaded from GET /api/plans.
  Future<PlanUpdateResult> updatePlan({
    required String planId,
    required String name,
    required String destination,
    required double? budget,
    required DateTime? startDate,
    required DateTime? endDate,
    required String timeZone,
    required bool autoCalculateStartDate,
    required bool autoCalculateEndDate,
    required List<String> hiddenFields,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanUpdateResult(status: 401);
      }
      final response = await http.put(
        Uri.parse('$backendBaseUrl$apiPlans/$planId'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': name,
          'destination': destination,
          'budget': budget,
          'startDate': startDate?.toUtc().toIso8601String(),
          'endDate': endDate?.toUtc().toIso8601String(),
          'timeZone': timeZone,
          'autoCalculateStartDate': autoCalculateStartDate,
          'autoCalculateEndDate': autoCalculateEndDate,
          'hiddenFields': hiddenFields,
        }),
      );
      if (response.statusCode != 200) {
        return PlanUpdateResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final planJson = data is Map ? data['plan'] : null;
      if (planJson is! Map) return const PlanUpdateResult(status: 200);
      final updated = Plan.fromJson(Map<String, dynamic>.from(planJson));
      _plans = [
        for (final plan in _plans)
          if (plan.id == planId)
            _planKeepingActivitySpan(updated, plan)
          else
            plan,
      ];
      notifyListeners();
      await _reloadPlan(planId, token);
      Plan? reloaded;
      for (final plan in _plans) {
        if (plan.id == planId) reloaded = plan;
      }
      return PlanUpdateResult(status: 200, plan: reloaded ?? updated);
    } catch (e) {
      logger.e('Error updating plan: $e');
      return const PlanUpdateResult();
    }
  }

  /// GET /api/places/autocomplete?q=. 200 is a short list of places.
  Future<PlaceSearchResult> searchPlaces({
    required String query,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlaceSearchResult(status: 401);
      }
      final response = await http.get(
        Uri.parse(
          '$backendBaseUrl$apiPlaceAutocomplete?q=${Uri.encodeQueryComponent(query)}',
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      if (response.statusCode != 200) {
        return PlaceSearchResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      if (data is! List) {
        return const PlaceSearchResult(status: 200);
      }
      final places = <PlaceSuggestion>[];
      for (final item in data) {
        if (item is! Map) continue;
        final placeId = (item['placeId'] ?? '').toString().trim();
        final name = (item['name'] ?? '').toString().trim();
        if (placeId.isEmpty || name.isEmpty) continue;
        places.add(
          PlaceSuggestion(
            placeId: placeId,
            name: name,
            address: (item['address'] ?? '').toString().trim(),
          ),
        );
      }
      return PlaceSearchResult(status: 200, places: places);
    } catch (e) {
      logger.e('Error searching places: $e');
      return const PlaceSearchResult(error: 'Could not search places');
    }
  }

  /// POST /api/plans/:planId/suggest. 200 is a short list of place options.
  Future<PlaceSearchResult> suggestActivityPlaces({
    required String planId,
    required String query,
    String? activityType,
    String? location,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlaceSearchResult(status: 401);
      }
      final body = <String, String>{'query': query.trim()};
      final type = activityType?.trim() ?? '';
      final place = location?.trim() ?? '';
      if (type.isNotEmpty) body['activityType'] = type;
      if (place.isNotEmpty) body['location'] = place;
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanSuggest.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(body),
      );
      if (response.statusCode != 200 && response.statusCode != 402) {
        return PlaceSearchResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      final list = response.statusCode == 402
          ? (data is Map ? data['places'] : null)
          : data;
      if (list is! List) {
        if (response.statusCode == 402) {
          return PlaceSearchResult(
            status: 402,
            error: _apiErrorMessage(response.body),
          );
        }
        return const PlaceSearchResult(status: 200);
      }
      final places = <PlaceSuggestion>[];
      for (final item in list) {
        if (item is! Map) continue;
        final placeId = (item['placeId'] ?? '').toString().trim();
        final name = (item['name'] ?? '').toString().trim();
        if (placeId.isEmpty || name.isEmpty) continue;
        places.add(
          PlaceSuggestion(
            placeId: placeId,
            name: name,
            address: (item['address'] ?? '').toString().trim(),
            summary: (item['summary'] ?? '').toString().trim(),
          ),
        );
      }
      return PlaceSearchResult(
        status: response.statusCode,
        error: response.statusCode == 402
            ? _apiErrorMessage(response.body)
            : null,
        places: places,
      );
    } catch (e) {
      logger.e('Error suggesting places: $e');
      return const PlaceSearchResult(error: 'Could not suggest places');
    }
  }

  /// POST /api/plans/:planId/ai-command. Returns a proposal and does not save.
  Future<AiCommandResult> proposeAiCommand({
    required String planId,
    required String instruction,
    required String? token,
    List<Map<String, String>> history = const [],
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const AiCommandResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanAiCommand.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'instruction': instruction.trim(),
          'history': history,
        }),
      );
      if (response.statusCode == 402) {
        return AiCommandResult(
          status: 402,
          error: _apiErrorMessage(response.body),
        );
      }
      if (response.statusCode != 200) {
        return AiCommandResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body) ?? 'Could not propose an edit',
        );
      }
      final data = json.decode(response.body);
      if (data is! Map) {
        return const AiCommandResult(
          status: 200,
          error: 'Could not propose an edit',
        );
      }
      final proposal = data['proposal'];
      if (proposal is! Map) {
        return const AiCommandResult(
          status: 200,
          error: 'Could not propose an edit',
        );
      }
      return AiCommandResult(
        status: 200,
        summary: (data['summary'] ?? '').toString().trim(),
        proposal: Map<String, dynamic>.from(proposal),
      );
    } catch (e) {
      logger.e('Error proposing an AI edit: $e');
      return const AiCommandResult(error: 'Could not propose an edit');
    }
  }

  /// POST /api/plans/:planId/ai-command/apply. Writes the confirmed proposal.
  Future<AiCommandApplyResult> applyAiCommand({
    required String planId,
    required Map<String, dynamic> proposal,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const AiCommandApplyResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl +
              apiPlanAiCommandApply.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(proposal),
      );
      if (response.statusCode != 200 && response.statusCode != 201) {
        return AiCommandApplyResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body) ?? 'Could not apply the edit',
        );
      }
      return AiCommandApplyResult(status: response.statusCode);
    } catch (e) {
      logger.e('Error applying an AI edit: $e');
      return const AiCommandApplyResult(error: 'Could not apply the edit');
    }
  }

  /// POST /api/plans/:planId/optimize-day. Returns time shifts and does not save.
  Future<OptimizeDayResult> proposeOptimizeDay({
    required String planId,
    required int day,
    required String mode,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const OptimizeDayResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanOptimizeDay.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'day': day, 'mode': mode}),
      );
      if (response.statusCode != 200) {
        return OptimizeDayResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body) ?? 'Could not optimize this day',
        );
      }
      final data = json.decode(response.body);
      if (data is! Map) {
        return const OptimizeDayResult(
          status: 200,
          error: 'Could not optimize this day',
        );
      }
      final raw = data['changes'];
      final changes = <Map<String, dynamic>>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is Map) changes.add(Map<String, dynamic>.from(item));
        }
      }
      return OptimizeDayResult(
        status: 200,
        summary: (data['summary'] ?? '').toString().trim(),
        changes: changes,
      );
    } catch (e) {
      logger.e('Error proposing a day optimization: $e');
      return const OptimizeDayResult(error: 'Could not optimize this day');
    }
  }

  /// POST /api/plans/:planId/optimize-day/apply. Writes the confirmed times.
  Future<OptimizeDayApplyResult> applyOptimizeDay({
    required String planId,
    required List<Map<String, dynamic>> changes,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const OptimizeDayApplyResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl +
              apiPlanOptimizeDayApply.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'changes': changes}),
      );
      if (response.statusCode != 200) {
        return OptimizeDayApplyResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body) ?? 'Could not update the day',
        );
      }
      return const OptimizeDayApplyResult(status: 200);
    } catch (e) {
      logger.e('Error applying a day optimization: $e');
      return const OptimizeDayApplyResult(error: 'Could not update the day');
    }
  }

  /// GET /api/plans/:planId/place-map?placeId=. 200 is a PNG around that place.
  Future<PlanPlaceMapResult> fetchPlanPlaceMap({
    required String planId,
    required String placeId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        logger.w('Place map GET status 401');
        return const PlanPlaceMapResult(status: 401);
      }
      final response = await http.get(
        Uri.parse(
          '$backendBaseUrl${apiPlanPlaceMap.replaceAll('{planId}', planId)}?placeId=${Uri.encodeQueryComponent(placeId)}',
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      if (response.statusCode == 401 || response.statusCode == 403) {
        logger.w('Place map GET status ${response.statusCode}');
      }
      if (response.statusCode == 401) {
        return const PlanPlaceMapResult(status: 401);
      }
      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        return PlanPlaceMapResult(status: response.statusCode);
      }
      return PlanPlaceMapResult(status: 200, bytes: response.bodyBytes);
    } catch (e) {
      logger.e('Error fetching place map: $e');
      return const PlanPlaceMapResult();
    }
  }

  /// DELETE /api/plans/:planId/members with { email }. 200 is success.
  Future<PlanMemberRemoveResult> removePlanMember({
    required String planId,
    required String email,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanMemberRemoveResult(status: 401);
      }
      final response = await http.delete(
        Uri.parse(
          backendBaseUrl + apiPlanMembers.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'email': email}),
      );
      if (response.statusCode == 200) {
        return const PlanMemberRemoveResult(status: 200);
      }
      if (response.statusCode == 401) {
        return const PlanMemberRemoveResult(status: 401);
      }
      return PlanMemberRemoveResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error removing plan member: $e');
      return const PlanMemberRemoveResult();
    }
  }

  /// POST /api/plans/:planId/reassign-coordinator with { email }.
  /// 200 moves ownership to that accepted Collaborator.
  Future<PlanReassignResult> reassignPlanOwner({
    required String planId,
    required String email,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanReassignResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanReassign.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'email': email}),
      );
      if (response.statusCode == 200) {
        final ownerId = _ownerIdFromBody(response.body);
        if (ownerId != null && ownerId.isNotEmpty) {
          _plans = [
            for (final plan in _plans)
              if (plan.id == planId) _planWithOwner(plan, ownerId) else plan,
          ];
        }
        _viewerRoles[planId] = 'Collaborator';
        notifyListeners();
        return PlanReassignResult(status: 200, ownerId: ownerId);
      }
      if (response.statusCode == 401) {
        return const PlanReassignResult(status: 401);
      }
      return PlanReassignResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error reassigning plan owner: $e');
      return const PlanReassignResult();
    }
  }

  /// POST /api/plans/:planId/invite/resend with { email }.
  /// 200 sends the same invite mail again. The pending role stays as it is.
  Future<PlanInviteResult> resendPlanInvite({
    required String planId,
    required String email,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanInviteResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanInviteResend.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'email': email}),
      );
      if (response.statusCode == 200) {
        return const PlanInviteResult(status: 200);
      }
      if (response.statusCode == 401) {
        return const PlanInviteResult(status: 401);
      }
      return PlanInviteResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error resending invite: $e');
      return const PlanInviteResult();
    }
  }

  /// POST /api/plans/:planId/invite with { email, role }.
  /// Role is Collaborator or Guest. 201 is success.
  Future<PlanInviteResult> inviteToPlan({
    required String planId,
    required String email,
    required String role,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanInviteResult(status: 401);
      }
      final response = await http.post(
        Uri.parse(
          backendBaseUrl + apiPlanInvite.replaceAll('{planId}', planId),
        ),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'email': email, 'role': role}),
      );
      if (response.statusCode == 201) {
        return const PlanInviteResult(status: 201);
      }
      if (response.statusCode == 401) {
        return const PlanInviteResult(status: 401);
      }
      return PlanInviteResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error inviting to plan: $e');
      return const PlanInviteResult();
    }
  }

  /// DELETE /api/plans/:planId. On 200 the plan leaves the loaded list.
  /// On 409 sharedWith names the other people and pending invites.
  Future<PlanDeleteResult> deletePlan({
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const PlanDeleteResult(status: 401);
      }
      final response = await http.delete(
        Uri.parse('$backendBaseUrl$apiPlans/$planId'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode == 200) {
        _plans = [
          for (final plan in _plans)
            if (plan.id != planId) plan,
        ];
        _viewerRoles.remove(planId);
        if (_currentPlanId == planId) {
          _itinerary = [];
          _activities = [];
          _activityWarnings = [];
          _itineraryError = null;
          _currentPlanId = null;
        }
        notifyListeners();
        return const PlanDeleteResult(status: 200);
      }
      if (response.statusCode == 409) {
        return PlanDeleteResult(
          status: 409,
          sharedWith: _sharedWithLabels(response.body),
          message: _apiErrorMessage(response.body),
        );
      }
      return PlanDeleteResult(
        status: response.statusCode,
        message: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error deleting plan: $e');
      return const PlanDeleteResult();
    }
  }

  /// DELETE /api/activities/:id. On 200 that row leaves the itinerary.
  Future<int?> deleteActivity({
    required String activityId,
    required String planId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) return 401;
      final response = await http.delete(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        _writeMessage = _apiErrorMessage(response.body);
        return response.statusCode;
      }
      _writeMessage = null;
      _itinerary = [
        for (final activity in _itinerary)
          if (activity.id != activityId) activity,
      ];
      _activities = List<Activity>.from(_itinerary);
      await _loadActivityWarnings(planId, token);
      await _loadActivityReactions(token);
      notifyListeners();
      if (planId.isNotEmpty) await _reloadPlan(planId, token);
      return 200;
    } catch (e) {
      logger.e('Error deleting activity: $e');
      return null;
    }
  }

  /// GET /api/activities/:id/history. The list is newest first, as the API returns it.
  Future<ActivityHistoryResult> fetchActivityHistory({
    required String activityId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityHistoryResult(status: 401);
      }
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/history'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );
      if (response.statusCode != 200) {
        return ActivityHistoryResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      if (data is! List) return const ActivityHistoryResult(status: 200);
      final revisions = <ActivityHistoryRevision>[];
      for (final item in data) {
        if (item is! Map) continue;
        final map = Map<String, dynamic>.from(item);
        final id = _trimmed(map['_id']);
        if (id.isEmpty) continue;
        revisions.add(
          ActivityHistoryRevision(
            id: id,
            userId: _trimmed(map['userId']),
            action: _trimmed(map['action']),
            createdAt: _trimmed(map['createdAt']),
          ),
        );
      }
      return ActivityHistoryResult(status: 200, revisions: revisions);
    } catch (e) {
      logger.e('Error loading activity history: $e');
      return const ActivityHistoryResult();
    }
  }

  /// POST /api/activities/:id/restore with { revisionId }. Does not notify anyone.
  Future<ActivityRestoreResult> restoreActivityRevision({
    required String activityId,
    required String revisionId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityRestoreResult(status: 401);
      }
      final response = await http.post(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/restore'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'revisionId': revisionId}),
      );
      if (response.statusCode == 200) {
        return const ActivityRestoreResult(status: 200);
      }
      return ActivityRestoreResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error restoring activity: $e');
      return const ActivityRestoreResult();
    }
  }

  /// GET /api/activities/:id/attachments. Any plan member.
  Future<ActivityAttachmentListResult> fetchActivityAttachments({
    required String activityId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityAttachmentListResult(status: 401);
      }
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/attachments'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return ActivityAttachmentListResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      final data = json.decode(response.body);
      if (data is! List) {
        return const ActivityAttachmentListResult(status: 200);
      }
      final attachments = <ActivityAttachment>[];
      for (final item in data) {
        final parsed = ActivityAttachment.tryParse(item);
        if (parsed != null) attachments.add(parsed);
      }
      return ActivityAttachmentListResult(
        status: 200,
        attachments: attachments,
      );
    } catch (e) {
      logger.e('Error loading attachments: $e');
      return const ActivityAttachmentListResult();
    }
  }

  /// POST /api/activities/:id/attachments with multipart field file.
  Future<ActivityAttachmentWriteResult> uploadActivityAttachment({
    required String activityId,
    required String filename,
    required Uint8List bytes,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityAttachmentWriteResult(status: 401);
      }
      final response = await http.postFile(
        Uri.parse('$backendBaseUrl$apiActivities/$activityId/attachments'),
        headers: {'Authorization': 'Bearer $token'},
        filename: attachmentUploadName(filename),
        bytes: bytes,
      );
      if (response.statusCode == 201) {
        return const ActivityAttachmentWriteResult(status: 201);
      }
      return ActivityAttachmentWriteResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error uploading attachment: $e');
      return const ActivityAttachmentWriteResult();
    }
  }

  /// GET /api/attachments/:id/file. Bytes stay in memory.
  Future<ActivityAttachmentFileResult> fetchActivityAttachmentFile({
    required String attachmentId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityAttachmentFileResult(status: 401);
      }
      final response = await http.get(
        Uri.parse('$backendBaseUrl$apiAttachments/$attachmentId/file'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return ActivityAttachmentFileResult(
          status: response.statusCode,
          error: _apiErrorMessage(response.body),
        );
      }
      if (response.bodyBytes.isEmpty) {
        return const ActivityAttachmentFileResult(
          status: 404,
          error: 'File not found',
        );
      }
      final header = response.headers['content-type'] ?? '';
      return ActivityAttachmentFileResult(
        status: 200,
        bytes: response.bodyBytes,
        mimeType: header.split(';').first.trim(),
      );
    } catch (e) {
      logger.e('Error opening attachment: $e');
      return const ActivityAttachmentFileResult();
    }
  }

  /// DELETE /api/attachments/:id. Uploader or Owner.
  Future<ActivityAttachmentWriteResult> deleteActivityAttachment({
    required String attachmentId,
    required String? token,
  }) async {
    try {
      if (token == null || token.isEmpty) {
        return const ActivityAttachmentWriteResult(status: 401);
      }
      final response = await http.delete(
        Uri.parse('$backendBaseUrl$apiAttachments/$attachmentId'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode == 200) {
        return const ActivityAttachmentWriteResult(status: 200);
      }
      return ActivityAttachmentWriteResult(
        status: response.statusCode,
        error: _apiErrorMessage(response.body),
      );
    } catch (e) {
      logger.e('Error deleting attachment: $e');
      return const ActivityAttachmentWriteResult();
    }
  }

  // Add activity to plan (real API POST /api/activities with token passed as param)
  Future<void> addActivity(Activity newActivity, String? token) async {
    try {
      if (token == null) throw Exception('No token—log in first');

      final baseUrl = backendBaseUrl;
      final url = Uri.parse(baseUrl + apiActivities);
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode(newActivity.toJson()),
      );

      if (response.statusCode == 201) {
        final data = json.decode(response.body);
        final createdActivity = Activity.fromJson(
          data['event'],
        ); // Backend returns the created activity
        _activities.add(createdActivity);
        _computeDayNumbers(newActivity.planId); // Recalculate days
        notifyListeners();
        logger.i('Added activity: ${createdActivity.name} from backend');
      } else {
        final errorData = json.decode(response.body);
        throw Exception(
          errorData['message'] ??
              'Failed to add activity: ${response.statusCode}',
        );
      }
    } catch (e) {
      logger.e('Error adding activity: $e');
      // Fallback: Add mock
      _activities.add(newActivity);
      _computeDayNumbers(newActivity.planId);
      notifyListeners();
    }
  }

  // Update activity (real API PUT /api/activities/:id with token passed as param)
  Future<void> updateActivityDocument(Activity updatedActivity, String? token) async {
    if (updatedActivity.id == null) {
      throw Exception(
        'Cannot update: Activity ID is null. Use addActivity for new activities.',
      ); // Early return with message
    }

    _isLoading = true;
    notifyListeners();

    try {
      if (token == null) throw Exception('No token—log in first');

      final baseUrl = backendBaseUrl;
      final url = Uri.parse('$baseUrl$apiActivities/${updatedActivity.id}');
      final body = json.encode(updatedActivity.toJson());
      logger.i('Updating activity: $body'); // Log data sent
      final response = await http.put(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: body,
      );

      logger.i(
        'Update response: ${response.statusCode} ${response.body}',
      ); // Log response
      if (response.statusCode == 200) {
        final index = _activities.indexWhere((e) => e.id == updatedActivity.id);
        if (index != -1) {
          _activities[index] = updatedActivity;
        }
        _computeDayNumbers(updatedActivity.planId); // Recalculate days
        notifyListeners();
        logger.i('Updated activity: ${updatedActivity.name} from backend');
      } else {
        throw Exception('Failed to update activity: ${response.statusCode}');
      }
    } catch (e) {
      logger.e('Error updating activity: $e');
      // Fallback: Add mock
      // _activities.add(updatedActivity);
      _computeDayNumbers(updatedActivity.planId);
      notifyListeners();
    }
  }

  Future<void> deleteActivityDocument(String activityId, String? token) async {
    if (activityId.isEmpty) {
      throw Exception('Invalid activity ID'); // Early check for empty ID
    }

    _isLoading = true;
    notifyListeners(); // Show spinner

    try {
      if (token == null) throw Exception('No token—log in first');

      final baseUrl = backendBaseUrl;
      final url = Uri.parse('$baseUrl$apiActivities/$activityId');
      final response = await http.delete(
        url,
        headers: {'Authorization': 'Bearer $token'},
      );

      if (response.statusCode == 200) {
        _activities.removeWhere(
          (activity) => activity.id == activityId,
        ); // Remove from local list
        logger.i('Deleted activity $activityId');
      } else {
        throw Exception('Delete activity failed: ${response.statusCode}');
      }
    } catch (e) {
      logger.e('Delete activity error: $e');
      rethrow; // Bubble up for UI handling (e.g., SnackBar)
    } finally {
      _isLoading = false;
      notifyListeners(); // Refresh UI
    }
  }

  // Full comparator for sorting (Cases 1-4: Time prevails, activityNum fallback)
  int _compareActivities(Activity a, Activity b) {
    // Primary: effectiveStartTime (Cases 1-3)
    final aStart =
        a.effectiveStartTime ?? DateTime(2100); // Nulls last (far future)
    final bStart = b.effectiveStartTime ?? DateTime(2100);
    final compareStart = aStart.compareTo(bStart);
    if (compareStart != 0) return compareStart;

    // Secondary: effectiveEndTime if start ties
    final aEnd = a.effectiveEndTime ?? DateTime(2100);
    final bEnd = b.effectiveEndTime ?? DateTime(2100);
    final compareEnd = aEnd.compareTo(bEnd);
    if (compareEnd != 0) return compareEnd;

    // Tertiary: activityNum fallback (Case 4)
    return (a.activityNum ?? 0).compareTo(b.activityNum ?? 0);
  }

  Map<String, int> _computeDayNumbers(String planId) {
    final planActivities = List<Activity>.from(
      _activities.where((e) => e.planId == planId),
    );
    if (planActivities.isEmpty) return {};

    planActivities.sort(_compareActivities);

    final dayNumbers = <String, int>{}; // Map to store activityId -> dayNumber
    int currentDay = 1;
    DateTime? priorEnd = planActivities.first.effectiveStartTime ?? DateTime.now();

    for (var activity in planActivities) {
      final activityId = activity.id ?? '';
      dayNumbers[activityId] = currentDay;

      final nextStart = activity.effectiveStartTime ?? priorEnd;
      final priorEndNonNull = priorEnd ?? DateTime.now();
      if ((nextStart?.isAfter(priorEndNonNull) ?? false) &&
          (nextStart?.day ?? 0) > (priorEndNonNull.day)) {
        currentDay++;
      }
      priorEnd =
          activity.effectiveEndTime ??
          nextStart!.add(activity.duration ?? Duration.zero);
    }
    return dayNumbers; // Return the computed map
  }

  Map<String, int> getDayNumbersForPlan(String planId) {
    return _computeDayNumbers(planId);
  }

  // Getter for sorted activities with all logic (Cases 1-6)
  List<Activity> get sortedActivities {
    final planActivities = List<Activity>.from(
      _activities.where((e) => e.planId == (_currentPlanId ?? '')),
    ); // Fixed: ?? '' for filter
    _computeDayNumbers(_currentPlanId ?? ''); // Fixed: ?? '' for parameter
    return planActivities..sort(_compareActivities);
  }

  // Setter for current plan ID
  set currentPlanId(String? planId) {
    _currentPlanId = planId;
    notifyListeners();
  }

  // Getter for current plan ID
  String? get currentPlanId => _currentPlanId;

  // Method to get icon data based on activity type
  IconData getIcon(ActivityType type) {
    switch (type) {
      case ActivityType.flight:
        return Icons.flight;
      case ActivityType.hotel:
        return Icons.hotel;
      case ActivityType.train:
        return Icons.train;
      case ActivityType.carRental:
      case ActivityType.carService:
      case ActivityType.drive:
        return Icons.directions_car;
      case ActivityType.taxi:
        return Icons.local_taxi;
      case ActivityType.bus:
        return Icons.directions_bus;
      case ActivityType.ferry:
        return Icons.directions_boat;
      case ActivityType.shuttle:
        return Icons.airport_shuttle;
      default:
        return Icons.event;
    }
  }
}
