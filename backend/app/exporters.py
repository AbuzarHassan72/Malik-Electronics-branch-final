from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


HEADER_FILL = PatternFill("solid", fgColor="111827")
SECTION_FILL = PatternFill("solid", fgColor="1E3A5F")
ACCENT_FILL = PatternFill("solid", fgColor="FACC15")
WHITE_FONT = Font(color="FFFFFF", bold=True)
BOLD_FONT = Font(bold=True)
THIN_TOP = Border(top=Side(style="thin", color="9CA3AF"))


def _style_title(ws, cell_ref: str, value: str):
    ws[cell_ref] = value
    ws[cell_ref].font = Font(bold=True, size=16, color="FFFFFF")
    ws[cell_ref].fill = HEADER_FILL
    ws[cell_ref].alignment = Alignment(horizontal="left", vertical="center")


def _style_headers(ws, row_idx: int, headers: list[str]):
    for col_idx, header in enumerate(headers, start=1):
        cell = ws.cell(row=row_idx, column=col_idx, value=header)
        cell.fill = SECTION_FILL
        cell.font = WHITE_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")


def _autofit(ws):
    for column_cells in ws.columns:
        max_len = 0
        col_letter = get_column_letter(column_cells[0].column)
        for cell in column_cells:
            value = "" if cell.value is None else str(cell.value)
            max_len = max(max_len, len(value))
        ws.column_dimensions[col_letter].width = min(max(max_len + 2, 12), 35)


def build_export_file(
    output_path: str,
    *,
    summary: dict,
    categories: list[dict],
    inventory: list[dict],
    purchases: list[dict],
    sales: list[dict],
    accounts: list[dict],
    filters: dict,
) -> str:
    wb = Workbook()
    ws = wb.active
    ws.title = "Overview"
    _style_title(ws, "A1", "Malik Electronic Export")
    ws.merge_cells("A1:D1")

    filter_rows = [
        ("Category", filters.get("category_name") or "All categories"),
        ("Start date", filters.get("start_date") or "All"),
        ("End date", filters.get("end_date") or "All"),
        ("Generated", filters.get("generated_at") or "-"),
    ]
    row = 3
    for label, value in filter_rows:
        ws[f"A{row}"] = label
        ws[f"A{row}"].font = BOLD_FONT
        ws[f"B{row}"] = value
        row += 1

    row += 1
    _style_headers(ws, row, ["Metric", "Value"])
    metrics = [
        ("Total categories", summary.get("total_categories", 0)),
        ("Total products", summary.get("total_products", 0)),
        ("Current stock units", summary.get("current_stock_units", 0)),
        ("Current stock value", summary.get("current_stock_value", 0)),
        ("Purchase total", summary.get("purchase_total", 0)),
        ("Sales total", summary.get("sales_total", 0)),
        ("Gross profit", summary.get("gross_profit", 0)),
    ]
    row += 1
    for label, value in metrics:
        ws.cell(row=row, column=1, value=label)
        ws.cell(row=row, column=2, value=value)
        row += 1

    sheets = [
        (
            "Categories",
            ["Name", "Icon", "Description", "Products", "Units", "Value"],
            [
                [item.get("name"), item.get("icon"), item.get("description"), item.get("product_count"), item.get("current_units"), item.get("current_value")]
                for item in categories
            ],
        ),
        (
            "Inventory",
            ["Category", "Location", "Model", "Company", "Color", "Size", "Current stock", "Purchase value", "Sales value", "Current stock value"],
            [
                [
                    item.get("category_name"),
                    item.get("location_name"),
                    item.get("model"),
                    item.get("company"),
                    item.get("color"),
                    item.get("size"),
                    item.get("current_stock"),
                    item.get("total_purchased_value"),
                    item.get("total_sales_value"),
                    item.get("current_stock_value"),
                ]
                for item in inventory
            ],
        ),
        (
            "Purchase History",
            ["Date", "Category", "Product", "Supplier", "Quantity", "Unit cost", "Total", "Reference"],
            [
                [item.get("purchase_date"), item.get("category_name"), item.get("product_label"), item.get("supplier_name"), item.get("quantity"), item.get("unit_cost"), item.get("total_amount"), item.get("reference_no")]
                for item in purchases
            ],
        ),
        (
            "Sales History",
            ["Date", "Category", "Product", "Customer", "Quantity", "Unit price", "Total", "Profit", "Invoice"],
            [
                [item.get("sale_date"), item.get("category_name"), item.get("product_label"), item.get("customer_name"), item.get("quantity"), item.get("unit_price"), item.get("total_amount"), item.get("total_profit"), item.get("invoice_number")]
                for item in sales
            ],
        ),
        (
            "Account Transactions",
            ["Date", "Type", "Direction", "Party", "Amount", "Status", "Category", "Product", "Description"],
            [
                [item.get("transaction_date"), item.get("transaction_type"), item.get("direction"), item.get("party_name"), item.get("amount"), item.get("status"), item.get("category_name"), item.get("product_label"), item.get("description")]
                for item in accounts
            ],
        ),
    ]

    for title, headers, rows in sheets:
        ws2 = wb.create_sheet(title)
        _style_title(ws2, "A1", title)
        ws2.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(2, len(headers)))
        _style_headers(ws2, 3, headers)
        current_row = 4
        for values in rows:
            for col_idx, value in enumerate(values, start=1):
                cell = ws2.cell(row=current_row, column=col_idx, value=value)
                if col_idx >= len(headers) - 2:
                    cell.alignment = Alignment(vertical="top", wrap_text=True)
            current_row += 1
        _autofit(ws2)

    _autofit(ws)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    return output_path
