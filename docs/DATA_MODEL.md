# Veri Modeli

## Temel varlıklar

### Organization

- id
- name
- tradeName
- taxOffice
- taxNumber
- phone
- email
- city
- district
- address
- currency = TRY
- timezone = Europe/Istanbul
- createdAt
- updatedAt

### User

- id
- organizationId
- firstName
- lastName
- email
- phone
- passwordHash
- role: OWNER | ADMIN | FINANCE | PROJECT_MANAGER
- status: INVITED | ACTIVE | SUSPENDED
- emailVerifiedAt
- lastLoginAt

### Invitation

- id
- organizationId
- email
- role
- tokenHash
- expiresAt
- acceptedAt
- invitedById

### Project

- id
- organizationId
- code
- name
- customerId
- city
- district
- address
- startDate
- plannedEndDate
- contractAmount
- estimatedBudget
- status
- notes

### ProjectMember

- organizationId
- projectId
- userId
- roleLabel opsiyonel
- unique(projectId, userId)

### Customer

- id
- organizationId
- type
- name
- identityOrTaxNumber
- taxOffice
- contactName
- phone
- email
- city
- district
- address

### Supplier

- id
- organizationId
- type: SUPPLIER | SUBCONTRACTOR | BOTH
- name
- identityOrTaxNumber
- taxOffice
- contactName
- phone
- email
- city
- district
- address

### TransactionCategory

- id
- organizationId
- type: INCOME | EXPENSE
- name
- parentId
- isSystem
- isActive

### FinancialTransaction

- id
- organizationId
- projectId nullable
- type: INCOME | EXPENSE
- customerId nullable
- supplierId nullable
- categoryId
- documentNumber
- description
- issueDate
- dueDate
- subtotal
- taxRate
- taxAmount
- totalAmount
- currency
- status
- cancelledAt
- cancelledById
- cancellationReason
- createdById

### Settlement

Gelir için tahsilat, gider için ödeme kaydıdır.

- id
- organizationId
- transactionId
- financialAccountId
- type: COLLECTION | PAYMENT
- amount
- settlementDate
- paymentMethod
- referenceNumber
- notes
- status: ACTIVE | CANCELLED
- createdById
- cancelledAt
- cancelledById *(Faz 3'te eklendi — ters kaydı kimin oluşturduğunun izi için)*
- cancellationReason
- idempotencyKey unique, nullable *(Faz 3'te eklendi — mükerrer form gönderimini engeller)*

### FinancialAccount

- id
- organizationId
- name
- type
- bankName nullable
- iban nullable
- currency
- openingBalance
- isActive

### AccountMovement

- id
- organizationId
- financialAccountId
- type: OPENING | COLLECTION | PAYMENT | TRANSFER_IN | TRANSFER_OUT | ADJUSTMENT | REVERSAL
- amount
- direction: CREDIT | DEBIT
- occurredAt
- settlementId nullable
- transferId nullable
- description
- createdById

### AccountTransfer

- id
- organizationId
- fromAccountId
- toAccountId
- amount
- transferDate
- description
- status: ACTIVE | CANCELLED *(Faz 3'te enum'a çevrildi, önceden serbest metin idi)*
- createdById
- cancelledAt, cancelledById, cancellationReason *(Faz 3)*
- idempotencyKey unique, nullable *(Faz 3)*

### ProjectBudgetItem

- id
- organizationId
- projectId
- categoryId
- plannedAmount
- notes

### Document

- id
- organizationId
- projectId nullable
- transactionId nullable
- supplierId nullable
- customerId nullable
- fileName
- storageKey
- mimeType
- size
- uploadedById

### AuditLog

- id
- organizationId
- actorId
- action
- entityType
- entityId
- beforeJson nullable
- afterJson nullable
- ipAddress nullable
- userAgent nullable
- createdAt

## İndeksler

- organizationId tüm tenant tablolarında indekslenmeli.
- `(organizationId, projectId)`
- `(organizationId, dueDate, status)`
- `(organizationId, type, issueDate)`
- `(organizationId, email)` kullanıcıda unique
- `(organizationId, code)` projede unique

## Silme politikası

- Finansal işlem ve settlement hard delete edilmez.
- Kullanıcı pasifleştirilir.
- Proje arşivlenir veya iptal edilir.
- Müşteri/tedarikçi ilişkili finansal kayıt varsa silinmez, pasifleştirilir.
