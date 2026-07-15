from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import urlparse

from lxml import etree


class LocalSchemaResolver(etree.Resolver):
    def __init__(self, schema_dir: Path) -> None:
        super().__init__()
        self.schema_dir = schema_dir.resolve()
        self.allowed = {
            "SuministroLR.xsd": self.schema_dir / "SuministroLR.xsd",
            "RespuestaSuministro.xsd": self.schema_dir / "RespuestaSuministro.xsd",
            "ConsultaLR.xsd": self.schema_dir / "ConsultaLR.xsd",
            "RespuestaConsultaLR.xsd": self.schema_dir / "RespuestaConsultaLR.xsd",
            "SuministroInformacion.xsd": self.schema_dir / "SuministroInformacion.xsd",
            "xmldsig-core-schema.xsd": self.schema_dir / "xmldsig-core-schema.xsd",
        }

    def resolve(self, url: str, public_id: str | None, context: object):  # type: ignore[no-untyped-def]
        name = Path(urlparse(url).path).name
        target = self.allowed.get(name)
        if target is None or not target.is_file():
            raise OSError(f"Resolucion XSD bloqueada: {url}")
        return self.resolve_filename(str(target), context)


def hardened_parser(schema_dir: Path) -> etree.XMLParser:
    parser = etree.XMLParser(
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        huge_tree=False,
        remove_comments=False,
    )
    parser.resolvers.add(LocalSchemaResolver(schema_dir))
    return parser


def main() -> None:
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--schema-dir", required=True, type=Path)
    arguments.add_argument("--xml", required=True, type=Path)
    arguments.add_argument("--root-schema", default="SuministroLR.xsd", choices=(
        "SuministroLR.xsd",
        "RespuestaSuministro.xsd",
        "ConsultaLR.xsd",
        "RespuestaConsultaLR.xsd",
    ))
    arguments.add_argument("--expect-invalid", action="store_true")
    arguments.add_argument("--swap-totals", action="store_true")
    args = arguments.parse_args()
    schema_dir = args.schema_dir.resolve()
    xml_path = args.xml.resolve()
    schema_path = schema_dir / args.root_schema
    if not schema_path.is_file() or not xml_path.is_file():
        raise SystemExit("Faltan el esquema raiz o el fixture XML.")

    parser = hardened_parser(schema_dir)
    schema_document = etree.parse(str(schema_path), parser)
    schema = etree.XMLSchema(schema_document)
    document_parser = etree.XMLParser(
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        huge_tree=False,
        remove_comments=False,
    )
    document = etree.parse(str(xml_path), document_parser)
    if args.swap_totals:
        if args.root_schema != "SuministroLR.xsd":
            raise SystemExit("--swap-totals solo es valido para SuministroLR.xsd.")
        namespace = {"sf": "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"}
        alta = document.find(".//sf:RegistroAlta", namespace)
        tax_total = document.find(".//sf:RegistroAlta/sf:CuotaTotal", namespace)
        invoice_total = document.find(".//sf:RegistroAlta/sf:ImporteTotal", namespace)
        if alta is None or tax_total is None or invoice_total is None:
            raise SystemExit("No se pudo construir el fixture negativo de orden.")
        tax_index = alta.index(tax_total)
        alta.remove(invoice_total)
        alta.insert(tax_index, invoice_total)
    try:
        schema.assertValid(document)
    except etree.DocumentInvalid:
        if args.expect_invalid:
            print(f"OK XSD rechazo esperado: {xml_path.name}")
            return
        raise
    if args.expect_invalid:
        raise SystemExit(f"El fixture debia ser invalido: {xml_path.name}")
    print(f"OK XSD offline: {xml_path.name}")


if __name__ == "__main__":
    main()
