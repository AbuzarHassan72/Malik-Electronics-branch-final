from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=6, max_length=128)


class PasswordVerifyRequest(BaseModel):
    password: str = Field(min_length=6, max_length=128)


class CredentialUpdateRequest(BaseModel):
    current_username: str = Field(min_length=3, max_length=80)
    current_password: str = Field(min_length=6, max_length=128)
    new_username: str = Field(default="", max_length=80)
    new_password: str = Field(default="", max_length=128)
    confirm_password: str = Field(default="", max_length=128)

    @field_validator("confirm_password")
    @classmethod
    def validate_confirm(cls, value: str, info):
        new_password = info.data.get("new_password") or ""
        if new_password and value != new_password:
            raise ValueError("New password and confirm password must match.")
        return value

    @field_validator("new_username", mode="before")
    @classmethod
    def normalize_new_username(cls, value):
        return (value or "").strip()

    @field_validator("new_password", "confirm_password", mode="before")
    @classmethod
    def normalize_optional_passwords(cls, value):
        return value or ""


class CategoryCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=240)
    icon: str = Field(default="📦", max_length=8)
    image_path: str = Field(default="", max_length=255)


class CategoryUpdate(CategoryCreate):
    pass


class LocationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=200)


class LocationUpdate(LocationCreate):
    pass


class CompanyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)


class ProductCreate(BaseModel):
    category_id: int
    location_id: int | None = None
    model: str = Field(min_length=1, max_length=120)
    series: str = Field(default="", max_length=120)
    company: str = Field(default="", max_length=120)
    color: str = Field(default="", max_length=60)
    size: str = Field(default="", max_length=60)
    image_path: str = Field(default="", max_length=255)
    min_stock: int = Field(default=0, ge=0)
    default_purchase_price: float = Field(default=0, ge=0)
    default_sale_price: float = Field(default=0, ge=0)
    opening_quantity: int = Field(default=0, ge=0)
    notes: str = Field(default="", max_length=500)


class ProductUpdate(ProductCreate):
    active: int = Field(default=1)
    added_quantity: int = Field(default=0, ge=0)


class ProductBatchCreate(BaseModel):
    category_id: int
    location_id: int | None = None
    model: str = Field(min_length=1, max_length=120)
    series: str = Field(default="", max_length=120)
    company: str = Field(default="", max_length=120)
    colors: list[str] = Field(default_factory=list)
    sizes: list[str] = Field(default_factory=list)
    image_path: str = Field(default="", max_length=255)
    min_stock: int = Field(default=0, ge=0)
    default_purchase_price: float = Field(default=0, ge=0)
    default_sale_price: float = Field(default=0, ge=0)
    opening_quantity: int = Field(default=0, ge=0)
    notes: str = Field(default="", max_length=500)

    @field_validator("colors", "sizes", mode="before")
    @classmethod
    def normalize_lists(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            return [item.strip() for item in value.split(',') if item.strip()]
        return [str(item).strip() for item in value if str(item).strip()]



class PurchaseCreate(BaseModel):
    product_id: int
    quantity: int = Field(gt=0)
    unit_cost: float = Field(ge=0)
    purchase_date: date
    supplier_name: str = Field(default="", max_length=120)
    supplier_phone: str = Field(default="", max_length=40)
    reference_no: str = Field(default="", max_length=120)
    notes: str = Field(default="", max_length=400)


class PurchaseUpdate(PurchaseCreate):
    pass


class SaleCreate(BaseModel):
    product_id: int
    quantity: int = Field(gt=0)
    unit_price: float = Field(ge=0)
    sale_date: date
    customer_name: str = Field(default="", max_length=120)
    customer_phone: str = Field(default="", max_length=40)
    reference_no: str = Field(default="", max_length=120)
    notes: str = Field(default="", max_length=400)


class SaleUpdate(SaleCreate):
    pass


class SaleTransactionItem(BaseModel):
    product_id: int
    quantity: int = Field(gt=0)
    unit_price: float = Field(ge=0)


class SaleTransactionCreate(BaseModel):
    customer_name: str = Field(min_length=2, max_length=120)
    phone_number: str = Field(default="", max_length=40)
    address: str = Field(default="", max_length=200)
    status: Literal["Paid", "Unpaid"] = "Paid"
    transaction_at: datetime
    notes: str = Field(default="", max_length=400)
    generate_pdf: bool = True
    ignore_duplicate: bool = False
    apply_discount: bool = False
    discount_name: str = Field(default="", max_length=80)
    discount_type: Literal["fixed", "percent"] = "fixed"
    discount_value: float = Field(default=0, ge=0)
    items: list[SaleTransactionItem] = Field(min_length=1)


class InvoiceItemCreate(BaseModel):
    product_id: int
    quantity: int = Field(gt=0)
    unit_price: float = Field(ge=0)


class InvoiceCreate(BaseModel):
    customer_name: str = Field(min_length=2, max_length=120)
    phone_number: str = Field(default="", max_length=40)
    address: str = Field(default="", max_length=200)
    status: Literal["Paid", "Unpaid"] = "Paid"
    invoice_date: date
    notes: str = Field(default="", max_length=400)
    items: list[InvoiceItemCreate] = Field(min_length=1)
    generate_pdf: bool = True
    ignore_duplicate: bool = False
    apply_discount: bool = False
    discount_name: str = Field(default="", max_length=80)
    discount_type: Literal["fixed", "percent"] = "fixed"
    discount_value: float = Field(default=0, ge=0)


class HistoryFilters(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    category_id: int | None = None
    customer: str | None = None
    supplier: str | None = None

    @field_validator("end_date")
    @classmethod
    def check_dates(cls, value, info):
        start = info.data.get("start_date")
        if value and start and value < start:
            raise ValueError("End date cannot be before start date.")
        return value



class DiscountRuleBase(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    discount_type: Literal["fixed", "percent"] = "fixed"
    discount_value: float = Field(default=0, ge=0)
    description: str = Field(default="", max_length=200)
    active: int = Field(default=1)


class DiscountRuleCreate(DiscountRuleBase):
    pass


class DiscountRuleUpdate(DiscountRuleBase):
    pass


class CatalogModelCreate(BaseModel):
    category_name: str = Field(min_length=2, max_length=80)
    company: str = Field(min_length=2, max_length=120)
    series: str = Field(default="", max_length=120)
    model: str = Field(min_length=1, max_length=160)
    default_price: float = Field(default=0, ge=0)
