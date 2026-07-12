"use strict";
// lib/schemas/utilSchemas40.js — JSON schema for xml_client tool

const UTIL_SCHEMAS_40 = [
  {
    name: "xml_client",
    description: "Zero-dependency XML file reader, writer, and query tool (pure Node.js fs; no npm deps). Parse, navigate, modify, and create XML files such as Maven pom.xml, Spring config, Android manifests, SVG, RSS/Atom feeds, SOAP/WSDL, .NET csproj, and any standard XML document. Operations: read (parse XML to JSON document), get (get element text or attribute by dot-path), set (set element text or attribute and rewrite), delete (remove element or attribute and rewrite), list (list children of an element), query (search by tag name or path with //deep syntax), add_node (insert a new element), stringify (convert JS object or file to pretty-printed XML). Path notation: 'root.child.grandchild' navigates elements; 'root.child[2]' selects third sibling by tag; 'root.element.@attrName' targets an attribute. Security: path NUL guard; 4 MB file cap; nesting depth limit (max 50); 100,000 node limit. Always available \u2014 does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get", "set", "delete", "list", "query", "add_node", "stringify"],
          description: "Operation to perform. read=parse XML file to JSON document object; get=get element text content or attribute value by dot-path; set=set element text or attribute value and rewrite file; delete=remove element or attribute and rewrite file; list=list direct child elements of an element; query=search for elements by tag name or path (supports //tagName deep search); add_node=insert a new element at a path; stringify=convert JS object spec or existing file to pretty-printed XML string.",
        },
        path: {
          type: "string",
          description: "Path to the XML file. Required for read, get, set, delete, list, query, add_node (base file). Optional for stringify (when using 'data' instead).",
        },
        xml_path: {
          type: "string",
          description: "Dot-notation path to an element or attribute within the XML document. Examples: 'project.version' (text of <version> inside <project>), 'project.dependencies.dependency[0].groupId' (first <dependency> child's <groupId>), 'project.@xmlns' (xmlns attribute on <project>), 'configuration.database.@host' (host attr on <database>). Required for get, set, delete. Optional for list (defaults to root element) and add_node (defaults to root element children).",
        },
        value: {
          description: "Value to set. For element paths: sets the text content. For @attr paths: sets the attribute value. Converted to string. Required for set.",
        },
        query: {
          type: "string",
          description: "Search query for the query operation. Supports: '//tagName' (find all elements with that tag name anywhere in the document), '//tagName/@attrName' (find attribute values), 'root/child' (navigate path with slash notation), '//tagName' with '*' as wildcard. Required for query.",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return for query operation (default: 100, max: 10000).",
        },
        node_spec: {
          type: "object",
          description: "Element specification for add_node. Object with: 'name' (required, tag name), 'attrs' (optional object of attribute key/values), 'text' (optional text content), 'children' (optional array of child node_spec objects). Example: { name: 'dependency', attrs: { scope: 'test' }, children: [{ name: 'groupId', text: 'junit' }, { name: 'artifactId', text: 'junit' }] }.",
        },
        position: {
          type: "string",
          enum: ["append", "prepend"],
          description: "Where to insert the new node for add_node: 'append' (default, add at end) or 'prepend' (add at beginning of parent's children).",
        },
        indent: {
          type: "number",
          description: "Spaces per indent level for pretty-printing XML output (default: 2 for stringify/add_node, 0=compact for set/delete). Set to 0 for compact output.",
        },
        data: {
          type: "object",
          description: "JS object spec to convert to XML for stringify operation. Must follow node_spec format: { name: 'rootTag', attrs: {}, text: '', children: [...] }. Required for stringify when 'path' is not given.",
        },
        output_path: {
          type: "string",
          description: "Optional output file path. For set/delete: defaults to overwriting 'path'. For add_node: defaults to overwriting 'path'. For stringify: if omitted, returns XML as string without writing.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_40 };
