import "server-only";

import { SaxesParser } from "saxes";

const soapNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
const supplyNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd";
const commonNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";
const supplyResponseNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";
const queryNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/ConsultaLR.xsd";
const queryResponseNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";

export const aeatSoapContract = {
  manifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
  wsdlVersion: "tikeV1.0",
  wsdlSha256: "05919120708ff7650612fa6683c9336eaf919335d9a4db10e86759190af48602",
  supplyResponseXsdSha256: "82acf80f785643caac13087aae66808ed721a13f08ca5218cf8ae81b695549ef",
  queryXsdSha256: "bf2cdb8fc4b95b291757a72b76d8fffca06a6d30d9329122ca2fd6b2d5f8f1b1",
  queryResponseXsdSha256: "de35063acb8d9ba0d6ae51acc6b595de9c2b12333250e95e13108ef5f2670d45"
} as const;

type XmlNode = {
  local: string;
  uri: string;
  text: string;
  children: XmlNode[];
};

export type AeatSubmitResponse = {
  kind: "SUBMISSION";
  csv: string | null;
  waitSeconds: number;
  status: "Correcto" | "ParcialmenteCorrecto" | "Incorrecto";
  lines: Array<{
    issuerTaxId: string;
    invoiceNumber: string;
    issueDate: string;
    operation: "Alta" | "Anulacion";
    status: "Correcto" | "AceptadoConErrores" | "Incorrecto";
    errorCode: string | null;
  }>;
};

export type AeatSoapFault = {
  kind: "FAULT";
  faultCode: string;
};

export type AeatQueryResponse = {
  kind: "QUERY";
  result: "ConDatos" | "SinDatos";
  hasMore: boolean;
  records: Array<{
    issuerTaxId: string;
    invoiceNumber: string;
    issueDate: string;
    status: "Correcto" | "AceptadoConErrores" | "Anulado";
    errorCode: string | null;
  }>;
};

export class AeatSoapCodecError extends Error {
  readonly code:
    | "AEAT_SOAP_DOCUMENT_INVALID"
    | "AEAT_SOAP_DOCUMENT_TOO_LARGE"
    | "AEAT_SOAP_DOCUMENT_TOO_COMPLEX"
    | "AEAT_SOAP_SCHEMA_MISMATCH";

  constructor(code: AeatSoapCodecError["code"]) {
    super(code);
    this.name = "AeatSoapCodecError";
    this.code = code;
  }
}

export function encodeAeatSubmitEnvelope(xml: Uint8Array): Uint8Array {
  const source = decodeUtf8(xml, 1024 * 1024);
  const root = parseXml(source);
  assertName(root, supplyNamespace, "RegFactuSistemaFacturacion");
  const body = source.replace(/^\uFEFF?<\?xml[^?]*\?>\s*/u, "");
  return Buffer.from(soapEnvelope(body), "utf8");
}

export function encodeAeatQueryEnvelope(input: {
  issuerName: string;
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  representative?: boolean;
}): Uint8Array {
  if (!isValidAeatDate(input.issueDate)) schemaMismatch();
  if (!/^[A-Z0-9]{9}$/.test(input.issuerTaxId)) schemaMismatch();
  if (input.issuerName.trim().length < 1 || input.issuerName.length > 120) schemaMismatch();
  if (input.invoiceNumber.trim().length < 1 || input.invoiceNumber.length > 60) schemaMismatch();
  const [, month, year] = input.issueDate.split("-");
  const representative = input.representative ? "<sf:IndicadorRepresentante>S</sf:IndicadorRepresentante>" : "";
  const query = `<sfLRC:ConsultaFactuSistemaFacturacion xmlns:sfLRC="${queryNamespace}" xmlns:sf="${commonNamespace}"><sfLRC:Cabecera><sf:IDVersion>1.0</sf:IDVersion><sf:ObligadoEmision><sf:NombreRazon>${escapeXml(input.issuerName)}</sf:NombreRazon><sf:NIF>${input.issuerTaxId}</sf:NIF></sf:ObligadoEmision>${representative}</sfLRC:Cabecera><sfLRC:FiltroConsulta><sfLRC:PeriodoImputacion><sf:Ejercicio>${year}</sf:Ejercicio><sf:Periodo>${month}</sf:Periodo></sfLRC:PeriodoImputacion><sfLRC:NumSerieFactura>${escapeXml(input.invoiceNumber)}</sfLRC:NumSerieFactura><sfLRC:FechaExpedicionFactura><sf:FechaExpedicionFactura>${input.issueDate}</sf:FechaExpedicionFactura></sfLRC:FechaExpedicionFactura></sfLRC:FiltroConsulta></sfLRC:ConsultaFactuSistemaFacturacion>`;
  return Buffer.from(soapEnvelope(query), "utf8");
}

export function decodeAeatSubmitEnvelope(xml: Uint8Array): AeatSubmitResponse | AeatSoapFault {
  const document = parseXml(decodeUtf8(xml, 2 * 1024 * 1024));
  const body = readSoapBody(document);
  const bodyChildren = significantChildren(body);
  if (bodyChildren.length !== 1) schemaMismatch();
  const payload = bodyChildren[0];
  if (payload.uri === soapNamespace && payload.local === "Fault") return decodeFault(payload);
  assertName(payload, supplyResponseNamespace, "RespuestaRegFactuSistemaFacturacion");

  const children = significantChildren(payload);
  let index = 0;
  const csvNode = takeOptional(children, index, supplyResponseNamespace, "CSV");
  if (csvNode) index += 1;
  const presentation = takeOptional(children, index, supplyResponseNamespace, "DatosPresentacion");
  if (presentation) {
    index += 1;
    validatePresentation(presentation);
  }
  validateHeader(requireAt(children, index++, supplyResponseNamespace, "Cabecera"));
  const wait = requireAt(children, index++, supplyResponseNamespace, "TiempoEsperaEnvio");
  const statusNode = requireAt(children, index++, supplyResponseNamespace, "EstadoEnvio");
  const lines: AeatSubmitResponse["lines"] = [];
  while (index < children.length) {
    const line = requireAt(children, index++, supplyResponseNamespace, "RespuestaLinea");
    lines.push(decodeLine(line));
    if (lines.length > 1000) complexityError();
  }

  const status = exactText(statusNode, 32);
  if (status !== "Correcto" && status !== "ParcialmenteCorrecto" && status !== "Incorrecto") schemaMismatch();
  const waitText = exactText(wait, 4);
  if (!/^\d{1,4}$/.test(waitText)) schemaMismatch();
  const csv = csvNode ? exactText(csvNode, 256) : null;
  return { kind: "SUBMISSION", csv, waitSeconds: Number(waitText), status, lines };
}

export function decodeAeatQueryEnvelope(xml: Uint8Array): AeatQueryResponse | AeatSoapFault {
  const document = parseXml(decodeUtf8(xml, 2 * 1024 * 1024));
  const body = readSoapBody(document);
  const bodyChildren = significantChildren(body);
  if (bodyChildren.length !== 1) schemaMismatch();
  const payload = bodyChildren[0];
  if (payload.uri === soapNamespace && payload.local === "Fault") return decodeFault(payload);
  assertName(payload, queryResponseNamespace, "RespuestaConsultaFactuSistemaFacturacion");

  const children = significantChildren(payload);
  let index = 0;
  validateQueryHeader(requireAt(children, index++, queryResponseNamespace, "Cabecera"));
  validateQueryPeriod(requireAt(children, index++, queryResponseNamespace, "PeriodoImputacion"));
  const pagination = exactText(requireAt(children, index++, queryResponseNamespace, "IndicadorPaginacion"), 1);
  if (!isYesNo(pagination)) schemaMismatch();
  const result = exactText(requireAt(children, index++, queryResponseNamespace, "ResultadoConsulta"), 8);
  if (result !== "ConDatos" && result !== "SinDatos") schemaMismatch();
  const records: AeatQueryResponse["records"] = [];
  while (children[index]?.uri === queryResponseNamespace && children[index]?.local === "RegistroRespuestaConsultaFactuSistemaFacturacion") {
    records.push(decodeQueryRecord(children[index++]));
    if (records.length > 1_000) complexityError();
  }
  const paginationKey = takeOptional(children, index, queryResponseNamespace, "ClavePaginacion");
  if (paginationKey) {
    validateInvoiceId(paginationKey);
    index += 1;
  }
  if (index !== children.length || (result === "SinDatos" && records.length !== 0)) schemaMismatch();
  return { kind: "QUERY", result, hasMore: pagination === "S", records };
}

function decodeQueryRecord(node: XmlNode): AeatQueryResponse["records"][number] {
  const children = significantChildren(node);
  let index = 0;
  const fiscalKey = validateInvoiceId(requireAt(children, index++, queryResponseNamespace, "IDFactura"));
  validateQueryRecordData(requireAt(children, index++, queryResponseNamespace, "DatosRegistroFacturacion"));
  const presentation = takeOptional(children, index, queryResponseNamespace, "DatosPresentacion");
  if (presentation) {
    validateQueryPresentation(presentation);
    index += 1;
  }
  const state = requireAt(children, index++, queryResponseNamespace, "EstadoRegistro");
  if (index !== children.length) schemaMismatch();
  const stateChildren = significantChildren(state);
  exactText(requireAt(stateChildren, 0, queryResponseNamespace, "TimestampUltimaModificacion"), 40);
  const status = exactText(requireAt(stateChildren, 1, queryResponseNamespace, "EstadoRegistro"), 24);
  if (status !== "Correcto" && status !== "AceptadoConErrores" && status !== "Anulado") schemaMismatch();
  let stateIndex = 2;
  const code = takeOptional(stateChildren, stateIndex, queryResponseNamespace, "CodigoErrorRegistro");
  if (code) stateIndex += 1;
  const description = takeOptional(stateChildren, stateIndex, queryResponseNamespace, "DescripcionErrorRegistro");
  if (description) {
    exactText(description, 500);
    stateIndex += 1;
  }
  if (stateIndex !== stateChildren.length) schemaMismatch();
  const errorCode = code ? exactText(code, 20) : null;
  if (errorCode !== null && !/^-?\d{1,18}$/.test(errorCode)) schemaMismatch();
  return { ...fiscalKey, status, errorCode };
}

function validateQueryHeader(node: XmlNode): void {
  const children = significantChildren(node);
  if (exactText(requireAt(children, 0, commonNamespace, "IDVersion"), 3) !== "1.0") schemaMismatch();
  const subject = children[1];
  if (!subject || subject.uri !== commonNamespace || (subject.local !== "ObligadoEmision" && subject.local !== "Destinatario")) schemaMismatch();
  validatePerson(subject);
  const representative = takeOptional(children, 2, commonNamespace, "IndicadorRepresentante");
  if (representative && exactText(representative, 1) !== "S") schemaMismatch();
  if (children.length !== (representative ? 3 : 2)) schemaMismatch();
}

function validateQueryPeriod(node: XmlNode): void {
  const children = significantChildren(node);
  const year = exactText(requireAt(children, 0, queryResponseNamespace, "Ejercicio"), 4);
  const period = exactText(requireAt(children, 1, queryResponseNamespace, "Periodo"), 2);
  if (children.length !== 2 || !/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(period)) schemaMismatch();
}

function validateQueryPresentation(node: XmlNode): void {
  const children = significantChildren(node);
  if (children.length !== 3) schemaMismatch();
  if (!/^[A-Z0-9]{9}$/.test(exactText(requireAt(children, 0, commonNamespace, "NIFPresentador"), 9))) schemaMismatch();
  exactText(requireAt(children, 1, commonNamespace, "TimestampPresentacion"), 40);
  exactText(requireAt(children, 2, commonNamespace, "IdPeticion"), 20);
}

function validateQueryRecordData(node: XmlNode): void {
  const allowedOrder = [
    "NombreRazonEmisor", "RefExterna", "Subsanacion", "RechazoPrevio", "SinRegistroPrevio", "GeneradoPor",
    "Generador", "TipoFactura", "TipoRectificativa", "FacturasRectificadas", "FacturasSustituidas",
    "ImporteRectificacion", "FechaOperacion", "DescripcionOperacion", "FacturaSimplificadaArt7273",
    "FacturaSinIdentifDestinatarioArt61d", "Macrodato", "EmitidaPorTerceroODestinatario", "Tercero",
    "Destinatarios", "Cupon", "Desglose", "CuotaTotal", "ImporteTotal", "Encadenamiento", "SistemaInformatico",
    "FechaHoraHusoGenRegistro", "NumRegistroAcuerdoFacturacion", "IdAcuerdoSistemaInformatico", "TipoHuella",
    "Huella", "NifRepresentante", "FechaFinVeriFactu", "Incidencia"
  ];
  let lastIndex = -1;
  for (const child of significantChildren(node)) {
    const currentIndex = allowedOrder.indexOf(child.local);
    if (child.uri !== queryResponseNamespace || currentIndex <= lastIndex) schemaMismatch();
    lastIndex = currentIndex;
  }
}

function decodeLine(node: XmlNode): AeatSubmitResponse["lines"][number] {
  const children = significantChildren(node);
  let index = 0;
  const fiscalKey = validateInvoiceId(requireAt(children, index++, supplyResponseNamespace, "IDFactura"));
  const operation = validateOperation(requireAt(children, index++, supplyResponseNamespace, "Operacion"));
  const externalRef = takeOptional(children, index, supplyResponseNamespace, "RefExterna");
  if (externalRef) {
    exactText(externalRef, 60);
    index += 1;
  }
  const statusNode = requireAt(children, index++, supplyResponseNamespace, "EstadoRegistro");
  const codeNode = takeOptional(children, index, supplyResponseNamespace, "CodigoErrorRegistro");
  if (codeNode) index += 1;
  const description = takeOptional(children, index, supplyResponseNamespace, "DescripcionErrorRegistro");
  if (description) {
    exactText(description, 1500);
    index += 1;
  }
  const duplicate = takeOptional(children, index, supplyResponseNamespace, "RegistroDuplicado");
  if (duplicate) {
    validateDuplicate(duplicate);
    index += 1;
  }
  if (index !== children.length) schemaMismatch();

  const status = exactText(statusNode, 32);
  if (status !== "Correcto" && status !== "AceptadoConErrores" && status !== "Incorrecto") schemaMismatch();
  const errorCode = codeNode ? exactText(codeNode, 20) : null;
  if (errorCode !== null && !/^-?\d{1,18}$/.test(errorCode)) schemaMismatch();
  return { ...fiscalKey, operation, status, errorCode };
}

function validatePresentation(node: XmlNode): void {
  const children = significantChildren(node);
  const taxId = requireAt(children, 0, commonNamespace, "NIFPresentador");
  const timestamp = requireAt(children, 1, commonNamespace, "TimestampPresentacion");
  if (children.length !== 2 || !/^[A-Z0-9]{9}$/.test(exactText(taxId, 9))) schemaMismatch();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(exactText(timestamp, 40))) schemaMismatch();
}

function validateHeader(node: XmlNode): void {
  const children = significantChildren(node);
  validatePerson(requireAt(children, 0, commonNamespace, "ObligadoEmision"));
  let index = 1;
  const representative = takeOptional(children, index, commonNamespace, "Representante");
  if (representative) {
    validatePerson(representative);
    index += 1;
  }
  const voluntary = takeOptional(children, index, commonNamespace, "RemisionVoluntaria");
  if (voluntary) {
    validateVoluntarySubmission(voluntary);
    index += 1;
  }
  const required = takeOptional(children, index, commonNamespace, "RemisionRequerimiento");
  if (required) {
    validateRequiredSubmission(required);
    index += 1;
  }
  if (index !== children.length) schemaMismatch();
}

function validatePerson(node: XmlNode): void {
  const children = significantChildren(node);
  const name = requireAt(children, 0, commonNamespace, "NombreRazon");
  const taxId = requireAt(children, 1, commonNamespace, "NIF");
  if (children.length !== 2) schemaMismatch();
  exactText(name, 120);
  if (!/^[A-Z0-9]{9}$/.test(exactText(taxId, 9))) schemaMismatch();
}

function validateInvoiceId(node: XmlNode): { issuerTaxId: string; invoiceNumber: string; issueDate: string } {
  const children = significantChildren(node);
  const taxId = requireAt(children, 0, commonNamespace, "IDEmisorFactura");
  const number = requireAt(children, 1, commonNamespace, "NumSerieFactura");
  const date = requireAt(children, 2, commonNamespace, "FechaExpedicionFactura");
  const issuerTaxId = exactText(taxId, 9);
  const invoiceNumber = exactText(number, 60);
  const issueDate = exactText(date, 10);
  if (children.length !== 3 || !/^[A-Z0-9]{9}$/.test(issuerTaxId) || !isValidAeatDate(issueDate)) schemaMismatch();
  return { issuerTaxId, invoiceNumber, issueDate };
}

function validateOperation(node: XmlNode): "Alta" | "Anulacion" {
  const children = significantChildren(node);
  const operation = requireAt(children, 0, commonNamespace, "TipoOperacion");
  const value = exactText(operation, 10);
  if (value !== "Alta" && value !== "Anulacion") schemaMismatch();
  let index = 1;
  for (const local of ["Subsanacion", "RechazoPrevio", "SinRegistroPrevio"]) {
    const child = takeOptional(children, index, commonNamespace, local);
    if (child) {
      const fieldValue = exactText(child, 1);
      if (local === "RechazoPrevio" ? !/^[SNX]$/.test(fieldValue) : !isYesNo(fieldValue)) schemaMismatch();
      index += 1;
    }
  }
  if (index !== children.length) schemaMismatch();
  return value;
}

function validateVoluntarySubmission(node: XmlNode): void {
  const children = significantChildren(node);
  let index = 0;
  const endDate = takeOptional(children, index, commonNamespace, "FechaFinVeriFactu");
  if (endDate) {
    if (!isValidAeatDate(exactText(endDate, 10))) schemaMismatch();
    index += 1;
  }
  const incident = takeOptional(children, index, commonNamespace, "Incidencia");
  if (incident) {
    if (!isYesNo(exactText(incident, 1))) schemaMismatch();
    index += 1;
  }
  if (index !== children.length) schemaMismatch();
}

function validateRequiredSubmission(node: XmlNode): void {
  const children = significantChildren(node);
  exactText(requireAt(children, 0, commonNamespace, "RefRequerimiento"), 18);
  const end = takeOptional(children, 1, commonNamespace, "FinRequerimiento");
  if (end && !isYesNo(exactText(end, 1))) schemaMismatch();
  if (children.length !== (end ? 2 : 1)) schemaMismatch();
}

function validateDuplicate(node: XmlNode): void {
  const children = significantChildren(node);
  exactText(requireAt(children, 0, commonNamespace, "IdPeticionRegistroDuplicado"), 20);
  const status = exactText(requireAt(children, 1, commonNamespace, "EstadoRegistroDuplicado"), 32);
  if (status !== "Correcta" && status !== "AceptadaConErrores" && status !== "Anulada") schemaMismatch();
  let index = 2;
  const code = takeOptional(children, index, commonNamespace, "CodigoErrorRegistro");
  if (code) {
    if (!/^-?\d{1,18}$/.test(exactText(code, 20))) schemaMismatch();
    index += 1;
  }
  const description = takeOptional(children, index, commonNamespace, "DescripcionErrorRegistro");
  if (description) {
    exactText(description, 500);
    index += 1;
  }
  if (index !== children.length) schemaMismatch();
}

function decodeFault(node: XmlNode): AeatSoapFault {
  const children = significantChildren(node);
  if (children.length < 2 || children.length > 4) schemaMismatch();
  const codeNode = requireAt(children, 0, "", "faultcode");
  const reasonNode = requireAt(children, 1, "", "faultstring");
  if (children[2] && !(["faultactor", "detail"].includes(children[2].local) && children[2].uri === "")) schemaMismatch();
  if (children[3] && !(children[3].local === "detail" && children[3].uri === "")) schemaMismatch();
  exactText(reasonNode, 512);
  return { kind: "FAULT", faultCode: exactText(codeNode, 128) };
}

function readSoapBody(document: XmlNode): XmlNode {
  assertName(document, soapNamespace, "Envelope");
  const children = significantChildren(document);
  let index = 0;
  const header = takeOptional(children, index, soapNamespace, "Header");
  if (header) {
    if (significantChildren(header).length !== 0) schemaMismatch();
    index += 1;
  }
  const body = requireAt(children, index++, soapNamespace, "Body");
  if (index !== children.length) schemaMismatch();
  return body;
}

function parseXml(source: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || source.includes("\0")) documentError();
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let textBytes = 0;
  let parseError: Error | null = null;
  parser.on("doctype", () => documentError());
  parser.on("processinginstruction", () => documentError());
  parser.on("cdata", () => documentError());
  parser.on("error", (error) => { parseError = error; });
  parser.on("opentag", (tag) => {
    nodes += 1;
    if (nodes > 5_000 || stack.length >= 32) complexityError();
    for (const attribute of Object.values(tag.attributes)) {
      const isNamespaceDeclaration = attribute.uri === "http://www.w3.org/2000/xmlns/";
      const isOfficialSoapBodyId =
        tag.uri === soapNamespace && tag.local === "Body" &&
        attribute.uri === "" && attribute.local === "Id" && attribute.value === "Body";
      if (!isNamespaceDeclaration && !isOfficialSoapBodyId) schemaMismatch();
    }
    const node: XmlNode = { local: tag.local, uri: tag.uri, text: "", children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) schemaMismatch();
    else root = node;
    stack.push(node);
  });
  parser.on("text", (text) => {
    textBytes += Buffer.byteLength(text, "utf8");
    if (textBytes > 256 * 1024) complexityError();
    const current = stack.at(-1);
    if (current) current.text += text;
    else if (text.trim()) schemaMismatch();
  });
  parser.on("closetag", () => { stack.pop(); });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof AeatSoapCodecError) throw error;
    documentError();
  }
  if (parseError || !root || stack.length !== 0) documentError();
  return root;
}

function decodeUtf8(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new AeatSoapCodecError("AEAT_SOAP_DOCUMENT_TOO_LARGE");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    documentError();
  }
}

function significantChildren(node: XmlNode): XmlNode[] {
  if (node.text.trim()) schemaMismatch();
  return node.children;
}

function assertName(node: XmlNode, uri: string, local: string): void {
  if (node.uri !== uri || node.local !== local) schemaMismatch();
}

function requireAt(children: XmlNode[], index: number, uri: string, local: string): XmlNode {
  const node = children[index];
  if (!node) schemaMismatch();
  assertName(node, uri, local);
  return node;
}

function takeOptional(children: XmlNode[], index: number, uri: string, local: string): XmlNode | null {
  const node = children[index];
  return node && node.uri === uri && node.local === local ? node : null;
}

function exactText(node: XmlNode, maxLength: number): string {
  if (node.children.length !== 0) schemaMismatch();
  const value = node.text.trim();
  if (!value || value.length > maxLength) schemaMismatch();
  return value;
}

function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${soapNamespace}"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function escapeXml(value: string): string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value)) schemaMismatch();
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function isYesNo(value: string): boolean {
  return value === "S" || value === "N";
}

function isValidAeatDate(value: string): boolean {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) return false;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function documentError(): never {
  throw new AeatSoapCodecError("AEAT_SOAP_DOCUMENT_INVALID");
}

function complexityError(): never {
  throw new AeatSoapCodecError("AEAT_SOAP_DOCUMENT_TOO_COMPLEX");
}

function schemaMismatch(): never {
  throw new AeatSoapCodecError("AEAT_SOAP_SCHEMA_MISMATCH");
}
