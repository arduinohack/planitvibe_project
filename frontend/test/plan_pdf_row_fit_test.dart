import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/plan_pdf.dart';

void main() {
  test('activity rows are 8-point, clocks stay tight, and cost and type fit', () async {
    final bytes = await buildPlanPdf(
      name: 'Fit Check',
      destination: 'Here',
      start: '10/05/26',
      end: '10/06/26',
      rows: const [
        PlanPdfRow(
          dayHeader: 'Day 1',
          type: 'Drive',
          name: 'Airport',
          start: '10/5 10:00 EDT',
          end: '10/5 11:00 EDT',
          duration: '60 min',
          location: 'Terminal',
          details:
              'A long details sentence that should take the extra column width.',
          bookingReference: '',
          cost: 'Cost(act):\n\$12.00',
          gate: '',
          baggageClaim: '',
          roomNumber: '',
          serviceProvider: '',
        ),
        PlanPdfRow(
          dayHeader: null,
          type: 'Car Service',
          name: 'Hotel',
          start: '10/5 12:00 EDT',
          end: '10/5 12:30 EDT',
          duration: '',
          location: '',
          details: 'More details after the clocks.',
          bookingReference: '',
          cost: '',
          gate: '',
          baggageClaim: '',
          roomNumber: '',
          serviceProvider: '',
        ),
        PlanPdfRow(
          dayHeader: null,
          type: 'Flight',
          name: 'Home',
          start: '10/5 15:00 EDT',
          end: '10/5 18:00 EDT',
          duration: '',
          location: '',
          details: '',
          bookingReference: '',
          cost: '',
          gate: '',
          baggageClaim: '',
          roomNumber: '',
          serviceProvider: '',
        ),
      ],
    );

    final page = _pdfPage(bytes);
    final literals = page.literals;
    expect(literals, contains('Drive'));
    expect(literals, contains('Flight'));
    expect(literals.join(' '), contains('Car'));
    expect(literals.join(' '), contains('Service'));
    expect(literals, contains('Name'));
    expect(literals, contains('Duration'));
    expect(literals.where((text) => text.contains('Duration')), ['Duration']);
    expect(literals, contains('Cost(act):'));
    expect(literals, contains(r'$12.00'));
    expect(literals.where((text) => text.startsWith('Cost(')), ['Cost(act):']);

    expect(page.fontSizeOf('Airport'), 8);
    expect(page.fontSizeOf('Start'), 10);
    expect(page.fontSizeOf('Details'), 10);

    expect(page.lineOf('Cost(act):'), isNot(page.lineOf(r'$12.00')));

    expect(page.columnWidthOf('Start'), lessThan(page.columnWidthOf('Details')));
    expect(page.columnWidthOf('End'), lessThan(page.columnWidthOf('Details')));
    expect(page.columnWidthOf('Duration'), lessThan(page.columnWidthOf('Details')));
  });

  test('empty day columns get no width and leftover goes to Name and Details', () async {
    const longDay = PlanPdfRow(
      dayHeader: 'Day 1',
      type: 'Drive',
      name: 'Airport',
      start: '10/5 10:00 EDT',
      end: '10/5 18:00 EDT',
      duration: '60 min',
      location: 'Terminal',
      details: 'A long note about the transfer.',
      bookingReference: 'AB12',
      cost: 'Cost(est):\n\$1,100.00',
      gate: 'A12',
      baggageClaim: '',
      roomNumber: '',
      serviceProvider: '',
    );
    const shortDay = PlanPdfRow(
      dayHeader: 'Day 2',
      type: 'Flight',
      name: 'Hop',
      start: '9:00',
      end: '9:30',
      duration: '',
      location: '',
      details: 'Brief.',
      bookingReference: '',
      cost: '',
      gate: '',
      baggageClaim: '',
      roomNumber: '',
      serviceProvider: '',
    );

    final page = _pdfPage(
      await buildPlanPdf(
        name: 'Width Check',
        destination: 'Here',
        start: '10/05/26',
        end: '10/06/26',
        rows: const [longDay, shortDay],
      ),
    );

    expect(page.literals.where((text) => text == 'Duration'), ['Duration']);
    expect(page.literals, contains(r'$1,100.00'));
    expect(page.literals.where((text) => text.contains('1,100')), [r'$1,100.00']);
    expect(page.literals, contains('Cost(est):'));
    expect(page.literals.where((text) => text == 'A12'), ['A12']);
    expect(page.literals.where((text) => text == 'Gate'), ['Gate']);
    expect(page.literals, isNot(contains('AB12')));
    expect(page.literals, isNot(contains('Booking')));
    expect(page.columnWidthsOf('Gate'), hasLength(1));
    expect(page.columnWidthsOf('Duration'), hasLength(1));
    expect(page.columnWidthsOf('Name'), hasLength(2));
    expect(page.columnWidthOf('Name'), greaterThan(page.columnWidthOf('Start')));
    expect(page.columnWidthOf('Details'), greaterThan(page.columnWidthOf('Start')));
    expect(
      page.columnWidthOf('Details'),
      greaterThan(page.columnWidthOf('Gate')),
    );
  });

  test('a Place ID map is drawn after that day with the name under it', () async {
    const png = [
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    final withMap = await buildPlanPdf(
      name: 'Map Check',
      destination: 'Sydney',
      start: '10/05/26',
      end: '10/06/26',
      rows: [
        PlanPdfRow(
          dayHeader: 'Day 1',
          type: 'Attraction',
          name: 'Opera',
          start: '10:00',
          end: '12:00',
          duration: '',
          location: 'Sydney Opera House',
          details: 'Tour',
          bookingReference: '',
          cost: '',
          gate: '',
          baggageClaim: '',
          roomNumber: '',
          serviceProvider: '',
          googlePlaceId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
          mapImage: Uint8List.fromList(png),
        ),
      ],
    );
    final withoutMap = await buildPlanPdf(
      name: 'Map Check',
      destination: 'Sydney',
      start: '10/05/26',
      end: '10/06/26',
      rows: const [
        PlanPdfRow(
          dayHeader: 'Day 1',
          type: 'Attraction',
          name: 'Opera',
          start: '10:00',
          end: '12:00',
          duration: '',
          location: 'Sydney Opera House',
          details: 'Tour',
          bookingReference: '',
          cost: '',
          gate: '',
          baggageClaim: '',
          roomNumber: '',
          serviceProvider: '',
          googlePlaceId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
        ),
      ],
    );
    expect(_pdfPage(withMap).literals, contains('Opera'));
    expect(
      latin1.decode(withMap, allowInvalid: true),
      contains(RegExp(r'/Subtype\s*/Image')),
    );
    expect(
      latin1.decode(withoutMap, allowInvalid: true),
      isNot(contains(RegExp(r'/Subtype\s*/Image'))),
    );
  });
}

class _PdfPage {
  _PdfPage(
    this.literals,
    this._fontSizes,
    this._lines,
    this._columnWidths,
    this._allColumnWidths,
  );

  final List<String> literals;
  final Map<String, double> _fontSizes;
  final Map<String, double> _lines;
  final Map<String, double> _columnWidths;
  final Map<String, List<double>> _allColumnWidths;

  double fontSizeOf(String text) => _fontSizes[text]!;

  double lineOf(String text) => _lines[text]!;

  double columnWidthOf(String heading) => _columnWidths[heading]!;

  List<double> columnWidthsOf(String heading) => _allColumnWidths[heading]!;
}

_PdfPage _pdfPage(Uint8List bytes) {
  final source = latin1.decode(bytes, allowInvalid: true);
  final streams = RegExp(
    r'stream\r?\n([\s\S]*?)\r?\nendstream',
  ).allMatches(source);
  final buffer = StringBuffer();
  for (final match in streams) {
    final raw = latin1.encode(match.group(1)!);
    try {
      buffer.write(latin1.decode(zlib.decode(raw), allowInvalid: true));
    } catch (_) {}
  }
  final text = buffer.toString();
  final literals = <String>[];
  final fontSizes = <String, double>{};
  final lines = <String, double>{};
  final columnWidths = <String, double>{};
  final allColumnWidths = <String, List<double>>{};
  var fontSize = 0.0;
  var columnWidth = 0.0;
  var textY = 0.0;
  final token = RegExp(
    r'([\d.]+) Tf|([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re|([\d.\-]+) ([\d.\-]+) Td \[\((?:\\.|[^\\)])*\)\]TJ',
  );
  for (final match in token.allMatches(text)) {
    if (match.group(1) != null) {
      fontSize = double.parse(match.group(1)!);
      continue;
    }
    if (match.group(2) != null) {
      columnWidth = double.parse(match.group(4)!);
      continue;
    }
    textY = double.parse(match.group(7)!);
    final rawLiteral = RegExp(
      r'\(((?:\\.|[^\\)])*)\)',
    ).firstMatch(match.group(0)!)!.group(1)!;
    final literal = _pdfLiteral(rawLiteral);
    literals.add(literal);
    fontSizes.putIfAbsent(literal, () => fontSize);
    lines.putIfAbsent(literal, () => textY);
    if (columnWidth > 0) {
      columnWidths.putIfAbsent(literal, () => columnWidth);
      allColumnWidths.putIfAbsent(literal, () => []).add(columnWidth);
    }
  }
  return _PdfPage(literals, fontSizes, lines, columnWidths, allColumnWidths);
}

String _pdfLiteral(String raw) {
  return raw.replaceAll(r'\(', '(').replaceAll(r'\)', ')');
}
