import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/providers/plan_provider.dart';
import 'package:planitvibe_frontend/screens/plan_detail_screen.dart';

void main() {
  const placeId = 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8';

  testWidgets('an ID-only payload renders a row and fills the Place ID', (
    tester,
  ) async {
    final parsed = parsePlaceSearchBody({
      'message': 'Insufficient AI credits',
      'places': [
        {'googlePlaceId': placeId},
      ],
    });
    expect(parsed.places, hasLength(1));
    expect(parsed.places.single.name, isEmpty);
    expect(parsed.places.single.address, isEmpty);
    expect(parsed.message, 'Insufficient AI credits');

    final savedPlaceId = TextEditingController();
    final location = TextEditingController(text: 'Old street');
    addTearDown(savedPlaceId.dispose);
    addTearDown(location.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlaceSearchResultList(
            places: parsed.places,
            query: 'Hydro, OK',
            message: parsed.message,
            onSelected: (place) {
              final selection = applySearchedPlace(
                place: place,
                query: 'Hydro, OK',
                location: location.text,
              );
              savedPlaceId.text = selection.googlePlaceId;
              if (selection.location != null) {
                location.text = selection.location!;
              }
            },
          ),
        ),
      ),
    );

    expect(find.text('Insufficient AI credits'), findsOneWidget);
    expect(find.text('Hydro, OK'), findsOneWidget);
    expect(find.text(placeId), findsNothing);

    await tester.tap(find.text('Hydro, OK'));
    await tester.pump();

    expect(savedPlaceId.text, placeId);
    expect(location.text, 'Hydro, OK');
  });

  testWidgets('a full result still shows the name and address', (tester) async {
    const place = PlaceSuggestion(
      placeId: placeId,
      name: 'Cafe Paris',
      address: 'Paris, France',
      timeZone: 'Europe/Paris',
    );

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: PlaceSearchResultList(
            places: [place],
            query: 'Cafe',
            onSelected: _ignorePlace,
          ),
        ),
      ),
    );

    expect(find.text('Cafe Paris, Paris, France'), findsOneWidget);
    expect(find.text('Insufficient AI credits'), findsNothing);
  });
}

void _ignorePlace(PlaceSuggestion place) {}
