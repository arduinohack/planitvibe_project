import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'itinerary_cache.dart';
import 'logger.dart';

/// Writes one JSON file per plan under the app documents directory.
class ItineraryCacheStore {
  ItineraryCacheStore({Future<String?> Function()? documentsDirectory})
      : _documentsDirectory = documentsDirectory;

  final Future<String?> Function()? _documentsDirectory;

  Future<void> save(ItinerarySnapshot snapshot) async {
    try {
      final root = await _root();
      if (root == null) return;
      await writeItineraryCacheFile(
        documentsDir: root,
        snapshot: snapshot,
        separator: Platform.pathSeparator,
      );
    } catch (e) {
      logger.e('Could not save itinerary: $e');
    }
  }

  Future<ItinerarySnapshot?> read(String planId) async {
    try {
      final root = await _root();
      if (root == null) return null;
      return await readItineraryCacheFile(
        documentsDir: root,
        planId: planId,
        separator: Platform.pathSeparator,
      );
    } catch (e) {
      logger.e('Could not read saved itinerary: $e');
      return null;
    }
  }

  Future<void> clear() async {
    try {
      final root = await _root();
      if (root == null) return;
      await clearItineraryCacheFiles(
        documentsDir: root,
        separator: Platform.pathSeparator,
      );
    } catch (e) {
      logger.e('Could not clear saved itineraries: $e');
    }
  }

  Future<String?> _root() async {
    final override = _documentsDirectory;
    if (override != null) return override();
    if (!itineraryCacheEnabled(
      web: kIsWeb,
      platform: defaultTargetPlatform.name,
    )) {
      return null;
    }
    final documents = await getApplicationDocumentsDirectory();
    final path = documents.path.trim();
    return path.isEmpty ? null : path;
  }
}

ItineraryCacheStore createItineraryCacheStore() => ItineraryCacheStore();

Future<void> writeItineraryCacheFile({
  required String documentsDir,
  required ItinerarySnapshot snapshot,
  String separator = '/',
}) async {
  final path = itineraryCacheFilePath(
    documentsDir: documentsDir,
    planId: snapshot.planId,
    separator: separator,
  );
  if (path == null) return;
  final file = File(path);
  await file.parent.create(recursive: true);
  await file.writeAsString(snapshot.encode(), flush: true);
}

Future<ItinerarySnapshot?> readItineraryCacheFile({
  required String documentsDir,
  required String planId,
  String separator = '/',
}) async {
  final path = itineraryCacheFilePath(
    documentsDir: documentsDir,
    planId: planId,
    separator: separator,
  );
  if (path == null) return null;
  final file = File(path);
  if (!await file.exists()) return null;
  final snapshot = ItinerarySnapshot.decode(await file.readAsString());
  if (snapshot == null || snapshot.planId != planId.trim()) return null;
  return snapshot;
}

Future<void> clearItineraryCacheFiles({
  required String documentsDir,
  String separator = '/',
}) async {
  final root = documentsDir.trim();
  if (root.isEmpty || separator.isEmpty) return;
  final prefix = root.endsWith(separator) ? root : '$root$separator';
  final folder = Directory(
    '$prefix${itineraryCacheFolder.replaceAll('/', separator)}',
  );
  if (await folder.exists()) await folder.delete(recursive: true);
}
