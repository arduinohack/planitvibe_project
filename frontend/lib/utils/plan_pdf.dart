import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

/// One itinerary row already ordered for the plan screen.
class PlanPdfRow {
  final String? dayHeader;
  final String type;
  final String name;
  final String start;
  final String end;
  final String duration;
  final String location;
  final String details;
  final String bookingReference;
  final String origin;
  final String originCountry;
  final String destination;
  final String confirmation;
  final String cost;
  final String gate;
  final String baggageClaim;
  final String roomNumber;
  final String serviceProvider;
  final String googlePlaceId;
  final Uint8List? mapImage;

  /// False opens [dayHeader] with no activity row.
  final bool includeRow;

  const PlanPdfRow({
    required this.dayHeader,
    required this.type,
    required this.name,
    required this.start,
    required this.end,
    required this.duration,
    required this.location,
    required this.details,
    required this.bookingReference,
    this.origin = '',
    this.originCountry = '',
    this.destination = '',
    this.confirmation = '',
    required this.cost,
    required this.gate,
    required this.baggageClaim,
    required this.roomNumber,
    required this.serviceProvider,
    this.googlePlaceId = '',
    this.mapImage,
    this.includeRow = true,
  });
}

/// File name taken from the plan name, safe to share or download.
String planPdfFilename(String planName) {
  final cleaned = planName
      .trim()
      .replaceAll(RegExp(r'[\\/:*?"<>|]'), ' ')
      .trim();
  final base = cleaned.isEmpty ? 'plan' : cleaned;
  if (base.toLowerCase().endsWith('.pdf')) return base;
  return '$base.pdf';
}

class _PdfDay {
  final String header;
  final List<PlanPdfRow> activities;

  _PdfDay(this.header, this.activities);
}

class _PdfColumn {
  final String heading;
  final String Function(PlanPdfRow row) value;
  final bool flex;
  final bool headingOneLine;
  final List<String> minBodyLines;

  const _PdfColumn(
    this.heading,
    this.value, {
    this.flex = false,
    this.headingOneLine = false,
    this.minBodyLines = const [],
  });
}

const _pdfColumns = [
  _PdfColumn('Type', _typeCell),
  _PdfColumn('Name', _nameCell, flex: true),
  _PdfColumn('Start', _startCell),
  _PdfColumn('End', _endCell),
  _PdfColumn('Duration', _durationCell, headingOneLine: true),
  _PdfColumn('Location', _locationCell),
  _PdfColumn('Origin', _originCell),
  _PdfColumn('Origin country', _originCountryCell),
  _PdfColumn('Destination', _destinationCell),
  _PdfColumn('Details', _detailsCell, flex: true),
  _PdfColumn('Confirmation', _confirmationCell),
  _PdfColumn(
    'Cost',
    _costCell,
    minBodyLines: ['Cost(est):', 'Cost(act):', r'$1,100.00'],
  ),
  _PdfColumn('Gate', _gateCell),
  _PdfColumn('Baggage claim', _baggageClaimCell),
  _PdfColumn('Room number', _roomNumberCell),
  _PdfColumn('Service provider', _serviceProviderCell),
];

String _typeCell(PlanPdfRow row) => row.type;
String _nameCell(PlanPdfRow row) => row.name;
String _startCell(PlanPdfRow row) => row.start;
String _endCell(PlanPdfRow row) => row.end;
String _durationCell(PlanPdfRow row) => row.duration;
String _locationCell(PlanPdfRow row) => row.location;
String _originCell(PlanPdfRow row) => row.origin;
String _originCountryCell(PlanPdfRow row) => row.originCountry;
String _destinationCell(PlanPdfRow row) => row.destination;
String _detailsCell(PlanPdfRow row) => row.details;
String _confirmationCell(PlanPdfRow row) => row.confirmation;
String _costCell(PlanPdfRow row) => row.cost;
String _gateCell(PlanPdfRow row) => row.gate;
String _baggageClaimCell(PlanPdfRow row) => row.baggageClaim;
String _roomNumberCell(PlanPdfRow row) => row.roomNumber;
String _serviceProviderCell(PlanPdfRow row) => row.serviceProvider;

String _tableCell(String value) {
  if (value.trim() == 'not set') return '';
  return value;
}

bool _cellHasValue(String value) {
  final text = value.trim();
  return text.isNotEmpty && text != 'not set';
}

List<_PdfColumn> _columnsInPrint(List<PlanPdfRow> rows) {
  final activities = rows.where((row) => row.includeRow);
  return [
    for (final column in _pdfColumns)
      if (activities.any((row) => _cellHasValue(column.value(row)))) column,
  ];
}

List<_PdfDay> _daysInOrder(List<PlanPdfRow> rows) {
  final days = <_PdfDay>[];
  for (final row in rows) {
    final header = row.dayHeader;
    if (header != null) {
      days.add(_PdfDay(header, row.includeRow ? [row] : []));
    } else if (row.includeRow) {
      if (days.isEmpty) days.add(_PdfDay('', []));
      days.last.activities.add(row);
    }
  }
  return days;
}

const _bodyFontSize = 8.0;
const _headerFontSize = 10.0;
const _cellPadding = 4.0;

double _lineWidth(PdfFont font, String text, double fontSize) {
  if (text.isEmpty) return 0;
  return font.stringMetrics(text).advanceWidth * fontSize;
}

double _headingMinWidth(PdfFont font, _PdfColumn column) {
  final heading = column.heading.trim();
  if (heading.isEmpty) return 0;
  if (column.headingOneLine) {
    return _lineWidth(font, heading, _headerFontSize);
  }
  var widest = 0.0;
  for (final word in heading.split(RegExp(r'\s+'))) {
    if (word.isEmpty) continue;
    final width = _lineWidth(font, word, _headerFontSize);
    if (width > widest) widest = width;
  }
  return widest;
}

double _columnMinWidth(
  PdfFont headerFont,
  PdfFont bodyFont,
  _PdfColumn column,
  List<PlanPdfRow> activities,
) {
  var widest = _headingMinWidth(headerFont, column);
  void consider(String text) {
    for (final line in text.split('\n')) {
      final width = _lineWidth(bodyFont, line.trim(), _bodyFontSize);
      if (width > widest) widest = width;
    }
  }

  for (final extra in column.minBodyLines) {
    consider(extra);
  }
  for (final row in activities) {
    consider(_tableCell(column.value(row)));
  }
  return widest + _cellPadding * 2 + 1;
}

/// Per-day widths from printed values. Empty columns get none. Leftover goes
/// to Name and Details.
Map<int, pw.TableColumnWidth> _balancedColumnWidths(
  PdfFont headerFont,
  PdfFont bodyFont,
  List<PlanPdfRow> activities,
  List<_PdfColumn> columns,
  double maxWidth,
) {
  final mins = [
    for (final column in columns)
      _columnMinWidth(headerFont, bodyFont, column, activities),
  ];
  final flexIndexes = [
    for (var index = 0; index < columns.length; index++)
      if (columns[index].flex) index,
  ];
  var fixed = 0.0;
  var flexMin = 0.0;
  for (var index = 0; index < columns.length; index++) {
    if (columns[index].flex) {
      flexMin += mins[index];
    } else {
      fixed += mins[index];
    }
  }
  final widths = List<double>.from(mins);
  if (flexIndexes.isNotEmpty) {
    final leftover = maxWidth - fixed;
    final share = leftover > 0 ? leftover / flexIndexes.length : 0.0;
    for (final index in flexIndexes) {
      widths[index] = share > mins[index] ? share : mins[index];
    }
    final used = widths.fold<double>(0, (sum, width) => sum + width);
    if (used > maxWidth && leftover > 0) {
      final scale = leftover / flexMin;
      for (final index in flexIndexes) {
        widths[index] = mins[index] * scale;
      }
    }
  }
  return {
    for (var index = 0; index < columns.length; index++)
      index: pw.FixedColumnWidth(widths[index]),
  };
}

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// Local clock of the device that builds the file: mm/dd/yy hh:nn, 24-hour.
String _generatedLabel(DateTime time) {
  final month = _twoDigits(time.month);
  final day = _twoDigits(time.day);
  final year = _twoDigits(time.year % 100);
  final hour = _twoDigits(time.hour);
  final minute = _twoDigits(time.minute);
  return 'Generated: $month/$day/$year $hour:$minute';
}

pw.Table _dayTable(
  List<PlanPdfRow> activities,
  List<_PdfColumn> columns,
  Map<int, pw.TableColumnWidth> columnWidths,
) {
  return pw.TableHelper.fromTextArray(
    headers: [for (final column in columns) column.heading],
    data: [
      for (final row in activities)
        [for (final column in columns) _tableCell(column.value(row))],
    ],
    border: pw.TableBorder.all(width: 0.4),
    headerStyle: pw.TextStyle(
      fontWeight: pw.FontWeight.bold,
      fontSize: _headerFontSize,
    ),
    cellStyle: pw.TextStyle(
      fontWeight: pw.FontWeight.normal,
      fontSize: _bodyFontSize,
    ),
    cellAlignment: pw.Alignment.topLeft,
    headerAlignment: pw.Alignment.topLeft,
    cellPadding: const pw.EdgeInsets.all(4),
    columnWidths: columnWidths,
    tableWidth: pw.TableWidth.min,
  );
}

String _mapCaption(PlanPdfRow row) {
  final name = row.name.trim();
  final location = row.location.trim();
  if (name.isNotEmpty && location.isNotEmpty && name != location) {
    return '$name - $location';
  }
  if (name.isNotEmpty) return name;
  if (location.isNotEmpty) return location;
  return 'Map';
}

/// One Google Map per Place ID on this day, in itinerary order.
List<pw.Widget> _dayMaps(List<PlanPdfRow> activities, double maxWidth) {
  final blocks = <pw.Widget>[];
  final seen = <String>{};
  for (final row in activities) {
    final image = row.mapImage;
    if (image == null || image.isEmpty) continue;
    final placeId = row.googlePlaceId.trim();
    if (placeId.isNotEmpty && !seen.add(placeId)) continue;
    blocks
      ..add(pw.SizedBox(height: 12))
      ..add(
        pw.Image(
          pw.MemoryImage(image),
          width: maxWidth,
          height: 220,
          fit: pw.BoxFit.cover,
        ),
      )
      ..add(pw.SizedBox(height: 6))
      ..add(
        pw.Text(
          _mapCaption(row),
          style: pw.TextStyle(fontSize: 11, fontWeight: pw.FontWeight.bold),
        ),
      );
  }
  return blocks;
}

/// PDF of the plan header and one table for each day, in the order given.
/// A day header with no activity rows is still drawn, with an empty table.
Future<Uint8List> buildPlanPdf({
  required String name,
  required String destination,
  required String start,
  required String end,
  required List<PlanPdfRow> rows,
  bool landscape = true,
  bool showDestination = true,
}) async {
  final document = pw.Document();
  final days = _daysInOrder(rows);
  final format = landscape ? PdfPageFormat.a4.landscape : PdfPageFormat.a4;
  final headerFont = PdfFont.helveticaBold(document.document);
  final bodyFont = PdfFont.helvetica(document.document);
  final generated = _generatedLabel(DateTime.now());
  final chrome = const pw.TextStyle(fontSize: 9);
  document.addPage(
    pw.MultiPage(
      pageFormat: format,
      header: (context) {
        if (context.pageNumber <= 1) return pw.SizedBox.shrink();
        return pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 8),
          child: pw.Text(
            name,
            style: pw.TextStyle(fontSize: 12, fontWeight: pw.FontWeight.bold),
          ),
        );
      },
      footer: (context) {
        return pw.Padding(
          padding: const pw.EdgeInsets.only(top: 8),
          child: pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text(generated, style: chrome),
              pw.Text(
                '${context.pageNumber} of ${context.pagesCount}',
                style: chrome,
              ),
            ],
          ),
        );
      },
      build: (context) {
        final blocks = <pw.Widget>[
          pw.Text(
            name,
            style: pw.TextStyle(fontSize: 18, fontWeight: pw.FontWeight.bold),
          ),
          pw.SizedBox(height: 8),
          if (showDestination)
            pw.Text(
              'Destination: $destination',
              style: const pw.TextStyle(fontSize: 10),
            ),
          pw.Text('Start: $start', style: const pw.TextStyle(fontSize: 10)),
          pw.Text('End: $end', style: const pw.TextStyle(fontSize: 10)),
          pw.SizedBox(height: 16),
        ];
        for (final day in days) {
          if (day.header.isNotEmpty) {
            blocks
              ..add(pw.SizedBox(height: 12))
              ..add(
                pw.Text(
                  day.header,
                  style: pw.TextStyle(
                    fontSize: 14,
                    fontWeight: pw.FontWeight.bold,
                  ),
                ),
              )
              ..add(pw.SizedBox(height: 6));
          }
          final columns = _columnsInPrint(day.activities);
          if (columns.isNotEmpty) {
            blocks.add(
              _dayTable(
                day.activities,
                columns,
                _balancedColumnWidths(
                  headerFont,
                  bodyFont,
                  day.activities,
                  columns,
                  format.availableWidth,
                ),
              ),
            );
          }
          blocks.addAll(_dayMaps(day.activities, format.availableWidth));
        }
        return blocks;
      },
    ),
  );
  return document.save();
}
